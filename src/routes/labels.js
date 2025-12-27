
// src/routes/labels.js (CommonJS)
const express = require("express")
const pool = require("../db")

const router = express.Router()
console.log("✅ LOADED labels router from:", __filename)

router.use((req, _res, next) => {
  console.log("[labels router]", req.method, req.originalUrl)
  next()
})

/* =========================================================
   Helpers
   ========================================================= */
function parsePositiveInt(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function getLabelIdNum(req, res) {
  const n = parsePositiveInt(req.params.labelId)
  if (!n) {
    res.status(400).json({ error: "labelId must be a positive integer" })
    return null
  }
  return n
}

/* =========================================================
   Auth guard for wizard-only endpoints
   ========================================================= */
function wizardOnly(req, res, next) {
  const key = req.get("x-wizard-key")
  const expected = process.env.WIZARD_KEY

  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: WIZARD_KEY not set" })
  }
  if (!key || key !== expected) {
    return res.status(403).json({ error: "Wizard-only endpoint" })
  }
  next()
}

/* =========================================================
   Metadata-only PATCH protections
   ========================================================= */
const FORBIDDEN_CONTENT_FIELDS = new Set([
  "frontLabel",
  "backLabel",
  "complianceBlock",
  "brief",
  "front_label",
  "back_label",
  "compliance_block",
])

const ALLOWED_METADATA_FIELDS = new Set([
  "internalNotes",
  "status",
  "tags",
  "ttbTrackingNumber",
  "ttbApplicationId",
])

function hasForbiddenContent(body) {
  for (const k of Object.keys(body || {})) {
    if (FORBIDDEN_CONTENT_FIELDS.has(k)) return k
  }
  return null
}

function pickAllowedMetadata(body) {
  const out = {}
  for (const k of Object.keys(body || {})) {
    if (ALLOWED_METADATA_FIELDS.has(k)) out[k] = body[k]
  }
  return out
}

/* =========================================================
   ✅ GLOBAL HISTORY FEED
   IMPORTANT: This MUST be defined BEFORE any "/:labelId" routes.
   GET /api/labels/history?limit=50
   GET /api/labels/label-history?limit=50  (alias)
   Returns: { ok: true, items: [...] }
   ========================================================= */
   async function globalHistoryHandler(req, res) {
     const limitRaw = Number(req.query.limit || 50)
     const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50), 250)

     try {
       const q = await pool.query(
         `
         SELECT
           id,
           label_id,
           action,
           brand_name,
           product_name,
           spirit_type,
           abv,
           volume_ml,
           tone,
           flavor_notes,
           region,
           brand_story,
           additional_notes,
           front_label,
           back_label,
           compliance_block,
           created_at,
           cola_status,
           cola_application_id,
           cola_last_changed_at
         FROM label_history
         ORDER BY created_at DESC, id DESC
         LIMIT $1
         `,
         [limit]
       )

       const items = q.rows.map((r) => ({
         id: r.id,
         historyId: r.id,
         labelId: Number(r.label_id),
         action: r.action,
         brandName: r.brand_name,
         productName: r.product_name,
         spiritType: r.spirit_type,
         abv: r.abv,
         volumeMl: r.volume_ml,
         tone: r.tone ?? null,
         flavorNotes: r.flavor_notes ?? null,
         region: r.region ?? null,
         brandStory: r.brand_story ?? null,
         additionalNotes: r.additional_notes ?? null,
         frontLabel: r.front_label,
         backLabel: r.back_label,
         complianceBlock: r.compliance_block,
         createdAt: r.created_at,
         colaStatus: r.cola_status ?? null,
         colaApplicationId: r.cola_application_id ?? null,
         colaLastChangedAt: r.cola_last_changed_at ?? null,
       }))

       return res.json({ ok: true, items })
     } catch (err) {
       return res.status(500).json({
         error: "Failed to load label history",
         detail: String(err && err.message ? err.message : err),
       })
     }
   }

// ✅ MUST be before any "/:labelId" routes:
router.get("/history", globalHistoryHandler)
router.get("/label-history", globalHistoryHandler)

/* =========================================================
   GENERATE (used by Wizard)
   POST /api/labels/generate
   ========================================================= */
router.post("/generate", async (req, res) => {
  const body = req.body || {}

  const brandName = String(body.brandName ?? "").trim()
  const productName = String(body.productName ?? "").trim()
  const spiritType = String(body.spiritType ?? "").trim()
  const tone = String(body.tone ?? "").trim() || "heritage"
  const region = String(body.region ?? "").trim()
  const brandStory = String(body.brandStory ?? "").trim()
  const flavorNotes = String(body.flavorNotes ?? "").trim()
  const additionalNotes = String(body.additionalNotes ?? "").trim()

  const abv = Number(body.abv)
  const volumeMl = Number(body.volumeMl)

  if (!brandName || !productName || !spiritType || !Number.isFinite(abv) || !Number.isFinite(volumeMl)) {
    return res.status(400).json({
      error: "Missing required fields: brandName, productName, spiritType, abv, volumeMl",
    })
  }

  const maybeId = parsePositiveInt(body.id)
  const hasValidId = !!maybeId

  let frontLabel = ""
  let backLabel = ""
  const complianceBlock =
    "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic beverages impairs your ability to drive a car or operate machinery, and may cause health problems."

  try {
    const key = process.env.OPENAI_API_KEY
    if (key) {
      const prompt = [
        `Write premium US spirits label copy.`,
        `Brand: ${brandName}`,
        `Product: ${productName}`,
        `Type: ${spiritType}`,
        `ABV: ${abv}%`,
        `Volume: ${volumeMl}ml`,
        `Tone/style: ${tone}`,
        region ? `Region: ${region}` : null,
        flavorNotes ? `Flavor notes: ${flavorNotes}` : null,
        brandStory ? `Brand story: ${brandStory}` : null,
        additionalNotes ? `Additional notes: ${additionalNotes}` : null,
        ``,
        `Return JSON with keys: frontLabel, backLabel (no markdown).`,
      ]
        .filter(Boolean)
        .join("\n")

      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          messages: [
            { role: "system", content: "You write compliant, marketing-grade spirits label copy." },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        }),
      })

      if (!r.ok) {
        const t = await r.text().catch(() => "")
        throw new Error(`OpenAI error ${r.status}: ${t}`)
      }

      const data = await r.json()
      const text = data?.choices?.[0]?.message?.content || ""

      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {}

      if (parsed && typeof parsed === "object") {
        frontLabel = String(parsed.frontLabel || "").trim()
        backLabel = String(parsed.backLabel || "").trim()
      }

      if (!frontLabel || !backLabel) {
        const parts = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
        frontLabel = frontLabel || parts[0] || `${brandName}\n${productName}\n${spiritType}`
        backLabel =
          backLabel ||
          parts.slice(1).join("\n\n") ||
          `${productName} is crafted in small batches. Notes: ${flavorNotes || "—"}.`
      }
    } else {
      frontLabel = `${brandName}\n${productName}\n${spiritType}\n${abv}% ABV • ${volumeMl}ml`
      backLabel = [
        `${productName} from ${brandName}.`,
        region ? `Crafted in ${region}.` : null,
        flavorNotes ? `Tasting notes: ${flavorNotes}.` : null,
        brandStory ? brandStory : null,
      ]
        .filter(Boolean)
        .join("\n\n")
    }
  } catch (err) {
    return res.status(500).json({
      error: "Failed to generate label copy",
      detail: String(err && err.message ? err.message : err),
    })
  }

// PUT /api/labels/history/:labelHistoryId
// Edit-in-place ONLY while COLA is not submitted (NULL or PREPARING)
router.put("/history/:labelHistoryId", wizardOnly, async (req, res) => {
  const id = Number(req.params.labelHistoryId)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid labelHistoryId" })
  }

  const {
    brandName,
    productName,
    spiritType,
    abv,
    volumeMl,
    tone,
    brandStory,
    flavorNotes,
    region,
    additionalNotes,
    frontLabel,
    backLabel,
    complianceBlock,
  } = req.body || {}

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    // lock rule: only editable if cola_status is NULL or PREPARING
    const cur = await client.query(
      `SELECT id, cola_status FROM label_history WHERE id = $1`,
      [id]
    )
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK")
      return res.status(404).json({ error: "Not found" })
    }

    const colaStatus = cur.rows[0].cola_status
    const editable = !colaStatus || colaStatus === "PREPARING"
    if (!editable) {
      await client.query("ROLLBACK")
      return res.status(409).json({
        error: "Version locked (already submitted). Create a new version.",
        colaStatus,
      })
    }

    // Update only known-safe columns. (Adjust column names if yours differ.)
    const upd = await client.query(
      `
      UPDATE label_history
      SET
        brand_name = COALESCE($2, brand_name),
        product_name = COALESCE($3, product_name),
        spirit_type = COALESCE($4, spirit_type),
        abv = COALESCE($5, abv),
        volume_ml = COALESCE($6, volume_ml),
        tone = COALESCE($7, tone),
        brand_story = COALESCE($8, brand_story),
        flavor_notes = COALESCE($9, flavor_notes),
        region = COALESCE($10, region),
        additional_notes = COALESCE($11, additional_notes),
        front_label = COALESCE($12, front_label),
        back_label = COALESCE($13, back_label),
        compliance_block = COALESCE($14, compliance_block)
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        brandName ?? null,
        productName ?? null,
        spiritType ?? null,
        abv ?? null,
        volumeMl ?? null,
        tone ?? null,
        brandStory ?? null,
        flavorNotes ?? null,
        region ?? null,
        additionalNotes ?? null,
        frontLabel ?? null,
        backLabel ?? null,
        complianceBlock ?? null,
      ]
    )

    await client.query("COMMIT")
    return res.json({ ok: true, item: upd.rows[0] })
  } catch (e) {
    await client.query("ROLLBACK")
    console.error("PUT /labels/history/:labelHistoryId failed", e)
    return res.status(500).json({ error: "Server error" })
  } finally {
    client.release()
  }
})


  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    let labelIdNum = null
    let action = "CREATE"

    if (hasValidId) {
      labelIdNum = maybeId

      const exists = await client.query(`SELECT current_history_id FROM labels WHERE id = $1`, [labelIdNum])
      action = exists.rows.length > 0 && exists.rows[0]?.current_history_id ? "UPDATE" : "CREATE"

      await client.query(
        `
        INSERT INTO labels (
          id, brand_name, product_name, spirit_type, abv, volume_ml,
          front_label, back_label, compliance_block, current_history_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
        ON CONFLICT (id) DO UPDATE SET
          brand_name       = EXCLUDED.brand_name,
          product_name     = EXCLUDED.product_name,
          spirit_type      = EXCLUDED.spirit_type,
          abv              = EXCLUDED.abv,
          volume_ml        = EXCLUDED.volume_ml,
          front_label      = EXCLUDED.front_label,
          back_label       = EXCLUDED.back_label,
          compliance_block = EXCLUDED.compliance_block
        `,
        [labelIdNum, brandName, productName, spiritType, abv, volumeMl, frontLabel, backLabel, complianceBlock]
      )
    } else {
      const ins = await client.query(
        `
        INSERT INTO labels (
          brand_name, product_name, spirit_type, abv, volume_ml,
          front_label, back_label, compliance_block, current_history_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
        RETURNING id
        `,
        [brandName, productName, spiritType, abv, volumeMl, frontLabel, backLabel, complianceBlock]
      )
      labelIdNum = ins.rows[0].id
      action = "CREATE"
    }

    const insertHistory = await client.query(
      `
      INSERT INTO label_history (
        label_id,
        action,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        tone,
        flavor_notes,
        region,
        brand_story,
        additional_notes,
        front_label,
        back_label,
        compliance_block
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
      `,
      [
        labelIdNum,
        action,
        brandName,
        productName,
        spiritType,
        abv,
        volumeMl,
        tone || null,
        flavorNotes || null,
        region || null,
        brandStory || null,
        additionalNotes || null,
        frontLabel,
        backLabel,
        complianceBlock,
      ]
    )

    const v = insertHistory.rows[0]
    await client.query(`UPDATE labels SET current_history_id = $2 WHERE id = $1`, [labelIdNum, v.id])

    await client.query("COMMIT")

    return res.json({
      id: labelIdNum,
      brandName,
      productName,
      spiritType,
      abv,
      volumeMl,
      tone,
      flavorNotes,
      region,
      brandStory,
      additionalNotes,
      label: { frontLabel, backLabel, complianceBlock },
    })
  } catch (err) {
    await client.query("ROLLBACK")
    return res.status(500).json({
      error: "Failed to persist generated label",
      detail: String(err && err.message ? err.message : err),
    })
  } finally {
    client.release()
  }
})

/* =========================================================
   GET a label snapshot + current version
   GET /api/labels/:labelId
   ========================================================= */
router.get("/:labelId", async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  try {
    const q = await pool.query(
      `
      SELECT
        l.*,
        h.id            AS history_id,
        h.action        AS history_action,
        h.created_at    AS history_created_at,
        h.brand_name    AS h_brand_name,
        h.product_name  AS h_product_name,
        h.spirit_type   AS h_spirit_type,
        h.abv           AS h_abv,
        h.volume_ml     AS h_volume_ml,
        h.front_label   AS h_front_label,
        h.back_label    AS h_back_label,
        h.compliance_block AS h_compliance_block,
        h.cola_status           AS h_cola_status,
        h.cola_application_id   AS h_cola_application_id,
        h.cola_last_changed_at  AS h_cola_last_changed_at
      FROM labels l
      LEFT JOIN label_history h
        ON h.id = l.current_history_id
      WHERE l.id = $1
      `,
      [labelIdNum]
    )

    if (q.rows.length === 0) return res.status(404).json({ error: "Label not found" })

    const row = q.rows[0]

    const label = { ...row }
    delete label.history_id
    delete label.history_action
    delete label.history_created_at
    delete label.h_brand_name
    delete label.h_product_name
    delete label.h_spirit_type
    delete label.h_abv
    delete label.h_volume_ml
    delete label.h_front_label
    delete label.h_back_label
    delete label.h_compliance_block
    delete label.h_cola_status
    delete label.h_cola_application_id
    delete label.h_cola_last_changed_at

    const currentVersion =
      row.history_id == null
        ? null
        : {
            id: row.history_id,
            action: row.history_action,
            createdAt: row.history_created_at,
            brandName: row.h_brand_name,
            productName: row.h_product_name,
            spiritType: row.h_spirit_type,
            abv: row.h_abv,
            volumeMl: row.h_volume_ml,
            frontLabel: row.h_front_label,
            backLabel: row.h_back_label,
            complianceBlock: row.h_compliance_block,
            colaStatus: row.h_cola_status ?? null,
            colaApplicationId: row.h_cola_application_id ?? null,
            colaLastChangedAt: row.h_cola_last_changed_at ?? null,
          }

    return res.json({ ok: true, label, currentVersion })
  } catch (err) {
    return res.status(500).json({
      error: "Failed to load label",
      detail: String(err && err.message ? err.message : err),
    })
  }
})

/* =========================================================
   GET versions for a specific label (newest first)
   GET /api/labels/:labelId/history?limit=50
   ========================================================= */
    router.get("/:labelId/history", async (req, res) => {
      const labelIdNum = getLabelIdNum(req, res)
      if (!labelIdNum) return

      const limitRaw = Number(req.query.limit || 50)
      const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50), 250)

      try {
        const q = await pool.query(
          `
          SELECT
            id,
            label_id,
            action,
            brand_name,
            product_name,
            spirit_type,
            abv,
            volume_ml,
            tone,
            flavor_notes,
            region,
            brand_story,
            additional_notes,
            front_label,
            back_label,
            compliance_block,
            created_at,
            cola_status,
            cola_application_id,
            cola_last_changed_at
          FROM label_history
          WHERE label_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2
          `,
          [labelIdNum, limit]
        )

        const versions = q.rows.map((r) => ({
          id: r.id,
          historyId: r.id,
          labelId: Number(r.label_id), // ✅ standardize
          action: r.action,
          brandName: r.brand_name,
          productName: r.product_name,
          spiritType: r.spirit_type,
          abv: r.abv,
          volumeMl: r.volume_ml,
          tone: r.tone ?? null,
          flavorNotes: r.flavor_notes ?? null,
          region: r.region ?? null,
          brandStory: r.brand_story ?? null,
          additionalNotes: r.additional_notes ?? null,
          frontLabel: r.front_label ?? "",
          backLabel: r.back_label ?? "",
          complianceBlock: r.compliance_block ?? "",
          createdAt: r.created_at,
          colaStatus: r.cola_status ?? null,
          colaApplicationId: r.cola_application_id ?? null,
          colaLastChangedAt: r.cola_last_changed_at ?? null,
        }))

        return res.json({ ok: true, versions })
      } catch (err) {
        return res.status(500).json({
          error: "Failed to load history",
          detail: String(err && err.message ? err.message : err),
        })
      }
    })

/* =========================================================
   WIZARD SAVE
   POST /api/labels/:labelId/wizard/save
   ========================================================= */
router.post("/:labelId/wizard/save", wizardOnly, async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  const body = req.body || {}

  const brandName = body.brandName
  const spiritType = body.spiritType
  const productName = body.productName
  const abv = body.abv
  const volumeMl = body.volumeMl
  const frontLabel = body.frontLabel
  const backLabel = body.backLabel
  const complianceBlock = body.complianceBlock

  if (
    !brandName ||
    !spiritType ||
    !productName ||
    abv === undefined ||
    volumeMl === undefined ||
    !frontLabel ||
    !backLabel ||
    !complianceBlock
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: brandName, spiritType, productName, abv, volumeMl, frontLabel, backLabel, complianceBlock",
    })
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    await client.query(
      `
      INSERT INTO labels (
        id,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        front_label,
        back_label,
        compliance_block,
        current_history_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL)
      ON CONFLICT (id) DO UPDATE SET
        brand_name       = EXCLUDED.brand_name,
        product_name     = EXCLUDED.product_name,
        spirit_type      = EXCLUDED.spirit_type,
        abv              = EXCLUDED.abv,
        volume_ml        = EXCLUDED.volume_ml,
        front_label      = EXCLUDED.front_label,
        back_label       = EXCLUDED.back_label,
        compliance_block = EXCLUDED.compliance_block
      `,
      [labelIdNum, brandName, productName, spiritType, Number(abv), Number(volumeMl), frontLabel, backLabel, complianceBlock]
    )

    const cur = await client.query(`SELECT current_history_id FROM labels WHERE id = $1`, [labelIdNum])
    const action = cur.rows[0]?.current_history_id ? "UPDATE" : "CREATE"

    const insertHistory = await client.query(
      `
      INSERT INTO label_history (
        label_id,
        action,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        front_label,
        back_label,
        compliance_block
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [labelIdNum, action, brandName, productName, spiritType, Number(abv), Number(volumeMl), frontLabel, backLabel, complianceBlock]
    )

    const v = insertHistory.rows[0]
    await client.query(`UPDATE labels SET current_history_id = $2 WHERE id = $1`, [labelIdNum, v.id])

    await client.query("COMMIT")

    return res.json({
      ok: true,
      version: {
        id: v.id,
        labelId: v.label_id,
        action: v.action,
        brandName: v.brand_name,
        productName: v.product_name,
        spiritType: v.spirit_type,
        abv: v.abv,
        volumeMl: v.volume_ml,
        frontLabel: v.front_label,
        backLabel: v.back_label,
        complianceBlock: v.compliance_block,
        createdAt: v.created_at,
      },
    })
  } catch (err) {
    await client.query("ROLLBACK")
    return res.status(500).json({
      error: "Wizard save failed",
      detail: String(err && err.message ? err.message : err),
    })
  } finally {
    client.release()
  }
})

/* =========================================================
   PATCH metadata only (no content edits)
   PATCH /api/labels/:labelId
   ========================================================= */
router.patch("/:labelId", async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  const body = req.body || {}

  const forbidden = hasForbiddenContent(body)
  if (forbidden) {
    return res.status(403).json({
      error: "Label content is wizard-only and versioned via label_history",
      field: forbidden,
    })
  }

  const meta = pickAllowedMetadata(body)
  const keys = Object.keys(meta)

  if (keys.length === 0) {
    return res.json({ ok: true, updated: false, reason: "No allowed fields" })
  }

  const exists = await pool.query(`SELECT 1 FROM labels WHERE id = $1`, [labelIdNum])
  if (exists.rows.length === 0) {
    return res.status(404).json({ error: "Label not found. Create it via the Wizard first." })
  }

  const mapKey = (k) => {
    if (k === "internalNotes") return "internal_notes"
    if (k === "ttbTrackingNumber") return "ttb_tracking_number"
    if (k === "ttbApplicationId") return "ttb_application_id"
    return k
  }

  const setClauses = []
  const values = [labelIdNum]
  let idx = 2

  for (const k of keys) {
    setClauses.push(`${mapKey(k)} = $${idx++}`)
    values.push(meta[k])
  }

  try {
    const q = await pool.query(`UPDATE labels SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`, values)
    return res.json({ ok: true, updated: true, label: q.rows[0] })
  } catch (err) {
    return res.status(500).json({
      error: "Metadata update failed",
      detail: String(err && err.message ? err.message : err),
    })
  }
})

// PUT /api/labels/history/:labelHistoryId
// Edit-in-place ONLY while COLA is not submitted (NULL or PREPARING)
router.put("/history/:labelHistoryId", wizardOnly, async (req, res) => {
  const id = Number(req.params.labelHistoryId)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid labelHistoryId" })
  }

  const { frontLabel, backLabel, complianceBlock } = req.body || {}

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const cur = await client.query(
      `SELECT id, cola_status FROM label_history WHERE id = $1`,
      [id]
    )

    if (cur.rowCount === 0) {
      await client.query("ROLLBACK")
      return res.status(404).json({ error: "Not found" })
    }

    const colaStatus = cur.rows[0].cola_status
    const editable = !colaStatus || colaStatus === "PREPARING"
    if (!editable) {
      await client.query("ROLLBACK")
      return res.status(409).json({
        error: "Version locked (already submitted). Create a new version.",
        colaStatus,
      })
    }

    const upd = await client.query(
      `
      UPDATE label_history
      SET
        front_label = COALESCE($2, front_label),
        back_label = COALESCE($3, back_label),
        compliance_block = COALESCE($4, compliance_block)
      WHERE id = $1
      RETURNING id, front_label, back_label, compliance_block, cola_status
      `,
      [id, frontLabel ?? null, backLabel ?? null, complianceBlock ?? null]
    )

    await client.query("COMMIT")
    return res.json({ ok: true, item: upd.rows[0] })
  } catch (e) {
    await client.query("ROLLBACK")
    console.error("PUT /api/labels/history/:labelHistoryId failed", e)
    return res.status(500).json({ error: "Server error" })
  } finally {
    client.release()
  }
})

// -------------------------------
// DRAFT ROUTES (editable workspace)
// label_id is BIGINT
// -------------------------------

// GET /api/labels/:labelId/draft
router.get("/:labelId/draft", async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  try {
    const q = await pool.query(
      `SELECT * FROM label_draft WHERE label_id = $1`,
      [labelIdNum]
    )

    if (q.rowCount > 0) {
      return res.json({ ok: true, draft: q.rows[0] })
    }

    const ins = await pool.query(
      `INSERT INTO label_draft (label_id) VALUES ($1) RETURNING *`,
      [labelIdNum]
    )

    return res.json({ ok: true, draft: ins.rows[0] })
  } catch (e) {
    console.error("GET /labels/:labelId/draft failed", e)
    return res.status(500).json({ error: "Server error" })
  }
})

// PUT /api/labels/:labelId/draft  (wizard-only)
router.put("/:labelId/draft", wizardOnly, async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  const {
    brandName,
    productName,
    spiritType,
    abv,
    volumeMl,
    tone,
    brandStory,
    flavorNotes,
    region,
    additionalNotes,
    frontLabel,
    backLabel,
    complianceBlock,
  } = req.body || {}

  try {
    const up = await pool.query(
      `
      INSERT INTO label_draft (
        label_id,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        tone,
        brand_story,
        flavor_notes,
        region,
        additional_notes,
        front_label,
        back_label,
        compliance_block,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (label_id) DO UPDATE SET
        brand_name = COALESCE(EXCLUDED.brand_name, label_draft.brand_name),
        product_name = COALESCE(EXCLUDED.product_name, label_draft.product_name),
        spirit_type = COALESCE(EXCLUDED.spirit_type, label_draft.spirit_type),
        abv = COALESCE(EXCLUDED.abv, label_draft.abv),
        volume_ml = COALESCE(EXCLUDED.volume_ml, label_draft.volume_ml),
        tone = COALESCE(EXCLUDED.tone, label_draft.tone),
        brand_story = COALESCE(EXCLUDED.brand_story, label_draft.brand_story),
        flavor_notes = COALESCE(EXCLUDED.flavor_notes, label_draft.flavor_notes),
        region = COALESCE(EXCLUDED.region, label_draft.region),
        additional_notes = COALESCE(EXCLUDED.additional_notes, label_draft.additional_notes),
        front_label = COALESCE(EXCLUDED.front_label, label_draft.front_label),
        back_label = COALESCE(EXCLUDED.back_label, label_draft.back_label),
        compliance_block = COALESCE(EXCLUDED.compliance_block, label_draft.compliance_block),
        updated_at = NOW()
      RETURNING *
      `,
      [
        labelIdNum,
        brandName ?? null,
        productName ?? null,
        spiritType ?? null,
        abv ?? null,
        volumeMl != null ? Number(volumeMl) : null,
        tone ?? null,
        brandStory ?? null,
        flavorNotes ?? null,
        region ?? null,
        additionalNotes ?? null,
        frontLabel ?? null,
        backLabel ?? null,
        complianceBlock ?? null,
      ]
    )

    return res.json({ ok: true, draft: up.rows[0] })
  } catch (e) {
    console.error("PUT /labels/:labelId/draft failed", e)
    return res.status(500).json({ error: "Server error" })
  }
})

// POST /api/labels/:labelId/publish  (wizard-only)
// Promote draft -> new label_history version (append-only)

// POST /api/labels/:labelId/publish  (wizard-only)
// Promote draft -> new label_history version (append-only)
// Falls back to latest history values when draft fields are null.
router.post("/:labelId/publish", wizardOnly, async (req, res) => {
  const labelIdNum = getLabelIdNum(req, res)
  if (!labelIdNum) return

  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const d = await client.query(
      `SELECT * FROM label_draft WHERE label_id = $1`,
      [labelIdNum]
    )
    if (d.rowCount === 0) {
      await client.query("ROLLBACK")
      return res.status(404).json({ error: "No draft found to publish" })
    }
    const draft = d.rows[0]

    // Latest published version (if any) used as fallback for NOT NULL columns
    const h = await client.query(
      `
      SELECT *
      FROM label_history
      WHERE label_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `,
      [labelIdNum]
    )
    const last = h.rowCount > 0 ? h.rows[0] : null

    // Decide action
    const action = last ? "UPDATE" : "CREATE"

    // Helper: use draft value if present, else last value, else null
    const pick = (draftVal, lastVal) =>
      draftVal !== null && draftVal !== undefined ? draftVal : (lastVal ?? null)

    // Build insert values with fallback
    const brand_name = pick(draft.brand_name, last?.brand_name)
    const product_name = pick(draft.product_name, last?.product_name)
    const spirit_type = pick(draft.spirit_type, last?.spirit_type)
    const abv = pick(draft.abv, last?.abv)
    const volume_ml = pick(draft.volume_ml, last?.volume_ml)

    const tone = pick(draft.tone, last?.tone)
    const flavor_notes = pick(draft.flavor_notes, last?.flavor_notes)
    const region = pick(draft.region, last?.region)
    const brand_story = pick(draft.brand_story, last?.brand_story)
    const additional_notes = pick(draft.additional_notes, last?.additional_notes)

    const front_label = pick(draft.front_label, last?.front_label)
    const back_label = pick(draft.back_label, last?.back_label)
    const compliance_block = pick(draft.compliance_block, last?.compliance_block)

    // Optional: keep cola_status PREPARING on new versions (or carry forward)
    const cola_status = "PREPARING"

    const ins = await client.query(
      `
      INSERT INTO label_history (
        label_id,
        action,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        tone,
        flavor_notes,
        region,
        brand_story,
        additional_notes,
        front_label,
        back_label,
        compliance_block,
        created_at,
        cola_status
      )
      VALUES (
        $1,$2,
        $3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,
        $13,$14,$15,
        NOW(),
        $16
      )
      RETURNING *
      `,
      [
        labelIdNum,
        action,
        brand_name,
        product_name,
        spirit_type,
        abv,
        volume_ml,
        tone,
        flavor_notes,
        region,
        brand_story,
        additional_notes,
        front_label,
        back_label,
        compliance_block,
        cola_status,
      ]
    )

    await client.query("COMMIT")
    return res.json({ ok: true, item: ins.rows[0] })
  } catch (e) {
    await client.query("ROLLBACK")
    console.error("POST /labels/:labelId/publish failed", e)
    return res.status(500).json({ error: "Server error" })
  } finally {
    client.release()
  }
})

module.exports = router

