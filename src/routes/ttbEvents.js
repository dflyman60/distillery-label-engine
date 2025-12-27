// src/routes/ttbEvents.js (CommonJS)
const express = require("express")
const router = express.Router()
const db = require("../db") // must expose db.query(...)

// ------------------------------------------------------------
// Health checks
// ------------------------------------------------------------
router.get("/__alive", (_req, res) => res.json({ ok: true }))
router.get("/__ttb_routes_alive", (_req, res) => res.json({ ok: true }))

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function parseId(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeStatusKey(v) {
  return String(v || "").trim().toUpperCase()
}

/**
 * Gate rule:
 * - Do NOT block PREPARING (draft)
 * - DO require finalized compliance review for "forward" statuses
 *
 * Adjust this list to match your real status_key vocabulary.
 */
const REQUIRES_COMPLIANCE = new Set([
  "SUBMITTED",
  "IN_REVIEW",
  "NEEDS_CORRECTION",
  "NEEDS_REVISION",
  "APPROVED",
  "REJECTED",
  "ISSUED",
])

async function hasFinalizedComplianceReview(labelHistoryId) {
  const q = await db.query(
    `
    SELECT 1
    FROM compliance_review_session
    WHERE label_history_id = $1 AND status = 'FINALIZED'
    LIMIT 1
    `,
    [labelHistoryId]
  )
  return q.rowCount > 0
}

// ------------------------------------------------------------
// GET: list events + current status
// NOTE: In this router, :id is treated as label_record_id (version id).
// If you later decide :id should be labels.id, adjust queries accordingly.
// ------------------------------------------------------------
router.get("/labels/:id/ttb-events", async (req, res) => {
  try {
    const labelRecordId = parseId(req.params.id)
    if (!labelRecordId) return res.status(400).json({ error: "Invalid label record id" })

    const { rows } = await db.query(
      `
      SELECT *
      FROM ttb_cola_events
      WHERE label_record_id = $1
      ORDER BY effective_at ASC, id ASC
      `,
      [labelRecordId]
    )

    const currentStatus = rows.length ? rows[rows.length - 1] : null
    return res.json({ ok: true, events: rows, currentStatus })
  } catch (err) {
    console.error("Error loading ttb events:", err)
    return res.status(500).json({ error: "Failed to load TTB events" })
  }
})

// ------------------------------------------------------------
// POST: insert a new status timeline event (with compliance gate)
// ------------------------------------------------------------
router.post("/labels/:id/ttb-events", async (req, res) => {
  const client = await db.connect()
  try {
    const labelRecordId = Number(req.params.id)
    if (!Number.isFinite(labelRecordId) || labelRecordId <= 0) {
      return res.status(400).json({ error: "Invalid label record id" })
    }

    const body = req.body || {}

    // Accept either snake_case or camelCase
    const status_key = body.status_key ?? body.statusKey
    const status_label = body.status_label ?? body.statusLabel
    const event_type = body.event_type ?? body.eventType ?? "STATUS"
    const effective_at = body.effective_at ?? body.effectiveAt ?? null
    const notes = body.notes ?? null
    const cola_id = body.cola_id ?? body.colaId ?? null
    const source = body.source ?? "user"
    const data = body.data ?? {}

    if (!status_key || !status_label) {
      return res.status(400).json({ error: "status_key and status_label are required" })
    }

    const statusKeyNorm = String(status_key).trim().toUpperCase()

    // ---- Compliance gate ----
    if (REQUIRES_COMPLIANCE.has(statusKeyNorm)) {
      const ok = await hasFinalizedComplianceReview(labelRecordId)
      if (!ok) {
        return res.status(409).json({
          error: "Compliance review must be finalized before advancing COLA status.",
          code: "COMPLIANCE_NOT_FINALIZED",
          labelHistoryId: labelRecordId,
          statusKey: statusKeyNorm,
        })
      }
    }

    await client.query("BEGIN")

    const ins = await client.query(
      `
      INSERT INTO ttb_cola_events
        (label_record_id, status_key, status_label, event_type, effective_at, notes, cola_id, source, data)
      VALUES
        ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6, $7, $8, $9::jsonb)
      RETURNING *
      `,
      [
        labelRecordId,
        statusKeyNorm,
        String(status_label).trim(),
        String(event_type).trim(),
        effective_at,
        notes,
        cola_id,
        String(source).trim(),
        JSON.stringify(data || {}),
      ]
    )

    const created = ins.rows[0]

    // ---- NEW: mirror latest status onto label_history ----
    await client.query(
      `
      UPDATE label_history
      SET
        cola_status = $2,
        cola_application_id = COALESCE($3, cola_application_id),
        cola_last_changed_at = COALESCE($4::timestamptz, NOW())
      WHERE id = $1
      `,
      [labelRecordId, created.status_key, created.cola_id || null, created.effective_at || null]
    )

    await client.query("COMMIT")
    return res.status(201).json({ ok: true, event: created })
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {}

    // IMPORTANT: return the real error during dev so you can see it
    console.error("Error inserting ttb event:", err)
    return res.status(500).json({
      error: "Failed to create TTB event",
      detail: err?.message || String(err),
    })
  } finally {
    client.release()
  }
})


module.exports = router

