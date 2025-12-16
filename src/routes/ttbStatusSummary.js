const express = require("express")
const router = express.Router()

module.exports = function ttbStatusSummaryRouter(db) {
    router.get("/api/labels/ttb-status-summary", async (req, res) => {
        try {
            const { rows } = await db.query(`
                SELECT DISTINCT ON (label_record_id)
                    label_record_id,
                    status_key,
                    status_label,
                    effective_at
                FROM ttb_cola_events
                ORDER BY label_record_id, effective_at DESC
            `)

            res.json({ items: rows })
        } catch (err) {
            console.error("TTB status summary error:", err)
            res.status(500).json({
                error: "Failed to load TTB status summary",
            })
        }
    })

    return router
}

