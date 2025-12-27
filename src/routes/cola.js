// src/routes/cola.js (CommonJS)
const express = require("express")
const pool = require("../db")

const router = express.Router()
console.log("✅ LOADED cola router from:", __filename)

function toInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

router.get("/:labelHistoryId", async (req, res) => {
  const id = toInt(req.params.labelHistoryId)
  if (!id) return res.status(400).json({ error: "Invalid labelHistoryId" })

  try {
    const cur = await pool.query(
      `
      SELECT
        id,
        label_id,
        product_name,
        spirit_type,
        cola_status,
        cola_application_id,
        cola_last_changed_at
      FROM label_history
      WHERE id = $1
      `,
      [id]
    )

    if (cur.rowCount === 0) return res.status(404).json({ error: "Not found" })

    return res.json({
      ok: true,
      current: cur.rows[0],
      timeline: [], // we’ll fill this in once cola_timeline exists
    })
  } catch (e) {
    console.error("GET /cola/:labelHistoryId failed", e)
    return res.status(500).json({ error: "Server error" })
  }
})

module.exports = router

