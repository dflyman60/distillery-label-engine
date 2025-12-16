// src/routes/labels.js (CommonJS)
const express = require("express")
const pool = require("../db")

const router = express.Router()
console.log("✅ LOADED labels router from:", __filename)

router.use((req, _res, next) => {
  console.log("[labels router]", req.method, req.originalUrl)
  next()
})

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

/**
 * IMPORTANT:
 * Your stack trace shows you're using the standalone `router` package
 * (node_modules/router/...), which does NOT support Express-style regex routes
 * like "/:labelId(\\d+)".
 *
 * So we validate labelId via router.param instead.
 */
router.param("labelId", (req, res, next, value) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ error: "labelId must be a positive integer" })
  }
  // normalize
  req.params.labelId = String(n)
  next()
})

function getLabelIdNum(req) {
  return Number(req.params.labelId)
}

/* =========================================================
   GLOBAL HISTORY FEED (Step 2A / LabelHistoryRadial)
   GET /api/labels/label-history?limit=50
   Returns: { ok: true, items: [...] }
   ========================================================= */
router.get("/label-history", async (req, res) => {
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
      labelId: r.label_id,
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
})

/* =========================================================
   STEP 1 WIRING (manual insert) — POST /api/labels/label-history
   Accepts snake_case OR camelCase body, returns 201 + version
   ========================================================= */
router.post("/label-history", async (req, res) => {
  const body = req.body || {}

  const labelId = Number(body.label_id ?? body.labelId)
  const action = String(body.action ?? "CREATE").toUpperCase()

  if (!Number.isInteger(labelId) || labelId <= 0) {
    return res.status(400).json({ error: "label_id must be a positive integer" })
  }

  const brandName = body.brand_name ?? body.brandName
  const productName = body.product_name ?? body.productName
  const spiritType = body.spirit_type ?? body.spiritType
  const abv = body.abv
  const volumeMl = body.volume_ml ?? body.volumeMl
  const frontLabel = body.front_label ?? body.frontLabel
  const backLabel = body.back_label ?? body.backLabel
  const complianceBlock = body.compliance_block ?? body.complianceBlock

  if (
    !brandName ||
    !productName ||
    !spiritType ||
    abv === undefined ||
    volumeMl === undefined ||
    !frontLabel ||
    !backLabel ||
    !complianceBlock
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: label_id, brand_name, product_name, spirit_type, abv, volume_ml, front_label, back_label, compliance_block",
    })
  }

  const historyColaStatus = body.history_cola_status ?? body.cola_status ?? null
  const historyColaApplicationId =
    body.history_cola_application_id ?? body.cola_application_id ?? null
  const historyColaLastChangedAt =
    body.history_cola_last_changed_at ?? body.cola_last_changed_at ?? null

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
      [
        labelId,
        brandName,
        productName,
        spiritType,
        Number(abv),
        Number(volumeMl),
        frontLabel,
        backLabel,
        complianceBlock,
      ]
    )

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
        compliance_block,
        cola_status,
        cola_application_id,
        cola_last_changed_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
      `,
      [
        labelId,
        action,
        brandName,
        productName,
        spiritType,
        Number(abv),
        Number(volumeMl),
        body.tone ?? null,
        body.flavor_notes ?? body.flavorNotes ?? null,
        body.region ?? null,
        body.brand_story ?? body.brandStory ?? null,
        body.additional_notes ?? body.additionalNotes ?? null,
        frontLabel,
        backLabel,
        complianceBlock,
        historyColaStatus,
        historyColaApplicationId,
        historyColaLastChangedAt,
      ]
    )

    const v = insertHistory.rows[0]

    await client.query(`UPDATE labels SET current_history_id = $2 WHERE id = $1`, [
      labelId,
      v.id,
    ])

    await client.query("COMMIT")

    return res.status(201).json({
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
        tone: v.tone ?? null,
        flavorNotes: v.flavor_notes ?? null,
        region: v.region ?? null,
        brandStory: v.brand_story ?? null,
        additionalNotes: v.additional_notes ?? null,
        frontLabel: v.front_label,
        backLabel: v.back_label,
        complianceBlock: v.compliance_block,
        colaStatus: v.cola_status,
        colaApplicationId: v.cola_application_id,
        colaLastChangedAt: v.cola_last_changed_at,
        createdAt: v.created_at,
      },
    })
  } catch (err) {
    await client.query("ROLLBACK")
    return res.status(500).json({
      error: "Failed to insert label_history",
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
  const labelIdNum = getLabelIdNum(req)

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
  const labelIdNum = getLabelIdNum(req)

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
      labelId: r.label_id,
      action: r.action,
      brandName: r.brand_name,
      productName: r.product_name,
      spiritType: r.spirit_type,
      abv: r.abv,
      volumeMl: r.volume_ml,
      frontLabel: r.front_label,
      backLabel: r.back_label,
      complianceBlock: r.compliance_block,
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
  const labelIdNum = getLabelIdNum(req)
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
      [
        labelIdNum,
        brandName,
        productName,
        spiritType,
        Number(abv),
        Number(volumeMl),
        frontLabel,
        backLabel,
        complianceBlock,
      ]
    )

    const cur = await client.query(`SELECT current_history_id FROM labels WHERE id = $1`, [
      labelIdNum,
    ])
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
      [
        labelIdNum,
        action,
        brandName,
        productName,
        spiritType,
        Number(abv),
        Number(volumeMl),
        frontLabel,
        backLabel,
        complianceBlock,
      ]
    )

    const v = insertHistory.rows[0]

    await client.query(`UPDATE labels SET current_history_id = $2 WHERE id = $1`, [
      labelIdNum,
      v.id,
    ])

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
  const labelIdNum = getLabelIdNum(req)
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
    const q = await pool.query(
      `UPDATE labels SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      values
    )
    return res.json({ ok: true, updated: true, label: q.rows[0] })
  } catch (err) {
    return res.status(500).json({
      error: "Metadata update failed",
      detail: String(err && err.message ? err.message : err),
    })
  }
})

module.exports = router

