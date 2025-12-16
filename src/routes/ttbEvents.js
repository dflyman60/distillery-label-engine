const express = require("express")
const router = express.Router()
const db = require("../db") // must expose db.query(...)

router.get("/__alive", (req, res) => res.json({ ok: true }))
router.get("/__ttb_routes_alive", (req, res) => res.json({ ok: true }))

router.get("/__alive", (req, res) => res.json({ ok: true }))

router.get("/labels/:id/ttb-events", async (req, res) => {
  try {
    const labelRecordId = Number(req.params.id)
    if (!Number.isFinite(labelRecordId)) {
      return res.status(400).json({ error: "Invalid label record id" })
    }

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
    return res.json({ events: rows, currentStatus })
  } catch (err) {
    console.error("Error loading ttb events:", err)
    return res.status(500).json({ error: "Failed to load TTB events" })
  }
})

router.post("/labels/:id/ttb-events", async (req, res) => {
  try {
    const labelRecordId = Number(req.params.id)
    if (!Number.isFinite(labelRecordId)) {
      return res.status(400).json({ error: "Invalid label record id" })
    }

    const {
      status_key,
      status_label,
      event_type = "STATUS",
      effective_at = null,
      notes = null,
      cola_id = null,
      source = "user",
      data = {},
    } = req.body || {}

    if (!status_key || !status_label) {
      return res
        .status(400)
        .json({ error: "status_key and status_label are required" })
    }

    const { rows } = await db.query(
      `
      INSERT INTO ttb_cola_events
        (label_record_id, status_key, status_label, event_type, effective_at, notes, cola_id, source, data)
      VALUES
        ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6, $7, $8, $9::jsonb)
      RETURNING *
      `,
      [
        labelRecordId,
        status_key,
        status_label,
        event_type,
        effective_at,
        notes,
        cola_id,
        source,
        JSON.stringify(data || {}),
      ]
    )

    return res.status(201).json(rows[0])
  } catch (err) {
    console.error("Error inserting ttb event:", err)
    return res.status(500).json({ error: "Failed to create TTB event" })
  }
})

module.exports = router

