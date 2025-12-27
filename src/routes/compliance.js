// src/routes/compliance.js (CommonJS)
const express = require("express")
const pool = require("../db")

const router = express.Router()

// Log early so every request is visible
router.use((req, _res, next) => {
  console.log("[compliance router]", req.method, req.originalUrl)
  next()
})

router.get("/ping", (_req, res) => res.json({ ok: true, route: "compliance" }))

// -------------------------
// Helpers
// -------------------------
function asText(v) {
  return typeof v === "string" ? v.trim() : ""
}
function requiredText(name, v) {
  const s = asText(v)
  if (!s) {
    const err = new Error(`${name} is required`)
    err.status = 400
    throw err
  }
  return s
}
function requiredInt(name, v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    const err = new Error(`${name} must be a positive integer`)
    err.status = 400
    throw err
  }
  return n
}
function decisionOk(d) {
  return ["PASS", "FAIL", "NEEDS_REVISION", "NOT_APPLICABLE"].includes(d)
}

// -------------------------
// Rules
// GET /api/compliance/rules?spiritType=BOURBON
// -------------------------
router.get("/rules", async (req, res, next) => {
  try {
    const spiritType = requiredText("spiritType", req.query.spiritType)

    const q = await pool.query(
      `
      SELECT spirit_type, rule_code, rule_version, rule_title, guidance_text, example_text, category
      FROM compliance_rule
      WHERE lower(trim(spirit_type)) = lower(trim($1)) AND active = true
      ORDER BY COALESCE(category, ''), rule_code, rule_version DESC
      `,
      [spiritType]
    )

    res.json({
      ok: true,
      items: q.rows.map((r) => ({
        spiritType: r.spirit_type,
        ruleCode: r.rule_code,
        ruleVersion: r.rule_version,
        ruleTitle: r.rule_title,
        guidanceText: r.guidance_text,
        exampleText: r.example_text,
        category: r.category,
      })),
    })
  } catch (e) {
    next(e)
  }
})

// -------------------------
// Review Sessions
// -------------------------

/**
 * POST /api/compliance/review/start
 * Body: { labelHistoryId, spiritType, reviewerId?, reviewerRole? }
 * Creates OR returns existing IN_PROGRESS session for label_history_id.
 */
router.post("/review/start", async (req, res, next) => {
  try {
    const labelHistoryId = requiredInt("labelHistoryId", req.body.labelHistoryId)
    const spiritType = requiredText("spiritType", req.body.spiritType)
    const reviewerId = asText(req.body.reviewerId) || null
    const reviewerRole = asText(req.body.reviewerRole) || null

    // Ensure label_history exists
    const lh = await pool.query(`SELECT id FROM label_history WHERE id = $1`, [labelHistoryId])
    if (lh.rowCount === 0) return res.status(404).json({ error: "label_history not found" })

    // Reuse existing IN_PROGRESS session if present
    const existing = await pool.query(
      `
      SELECT id, label_history_id, spirit_type, reviewer_id, reviewer_role, started_at, finalized_at, status
      FROM compliance_review_session
      WHERE label_history_id = $1 AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [labelHistoryId]
    )

    if (existing.rowCount > 0) {
      return res.json({ ok: true, session: existing.rows[0], reused: true })
    }

    const created = await pool.query(
      `
      INSERT INTO compliance_review_session
        (label_history_id, spirit_type, reviewer_id, reviewer_role, status)
      VALUES
        ($1, $2, $3, $4, 'IN_PROGRESS')
      RETURNING id, label_history_id, spirit_type, reviewer_id, reviewer_role, started_at, finalized_at, status
      `,
      [labelHistoryId, spiritType, reviewerId, reviewerRole]
    )

    res.json({ ok: true, session: created.rows[0], reused: false })
  } catch (e) {
    next(e)
  }
})

/**
 * GET /api/compliance/review/session?labelHistoryId=16
 * Returns best session:
 * - IN_PROGRESS if exists else most recent FINALIZED else null.
 */
router.get("/review/session", async (req, res, next) => {
  try {
    const labelHistoryId = requiredInt("labelHistoryId", req.query.labelHistoryId)

    const q = await pool.query(
      `
      SELECT id, label_history_id, spirit_type, reviewer_id, reviewer_role, started_at, finalized_at, status
      FROM compliance_review_session
      WHERE label_history_id = $1
      ORDER BY
        CASE WHEN status = 'IN_PROGRESS' THEN 0 ELSE 1 END,
        COALESCE(finalized_at, started_at) DESC,
        id DESC
      LIMIT 1
      `,
      [labelHistoryId]
    )

    res.json({ ok: true, session: q.rows[0] || null })
  } catch (e) {
    next(e)
  }
})

// -------------------------
// Review Events
// -------------------------

/**
 * GET /api/compliance/review/session/:sessionId/events
 */
router.get("/review/session/:sessionId/events", async (req, res, next) => {
  try {
    const sessionId = requiredInt("sessionId", req.params.sessionId)

    const q = await pool.query(
      `
      SELECT
        id, session_id, rule_code, rule_version, rule_title, guidance_text, sample_reference,
        decision, reviewer_comment, created_at
      FROM compliance_review_event
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [sessionId]
    )

    res.json({ ok: true, items: q.rows })
  } catch (e) {
    next(e)
  }
})

/**
 * POST /api/compliance/review/event
 * Body: { sessionId, ruleCode, ruleVersion, decision, reviewerComment? }
 * Snapshots guidance from compliance_rule.
 */
router.post("/review/event", async (req, res, next) => {
  try {
    const sessionId = requiredInt("sessionId", req.body.sessionId)
    const ruleCode = requiredText("ruleCode", req.body.ruleCode)
    const ruleVersion = requiredText("ruleVersion", req.body.ruleVersion)
    const decision = requiredText("decision", req.body.decision)
    const reviewerComment = asText(req.body.reviewerComment) || null

    if (!decisionOk(decision)) return res.status(422).json({ error: "Invalid decision value" })

    const sessionQ = await pool.query(
      `SELECT id, spirit_type, status FROM compliance_review_session WHERE id = $1`,
      [sessionId]
    )
    if (sessionQ.rowCount === 0) return res.status(404).json({ error: "Session not found" })

    const session = sessionQ.rows[0]
    if (session.status !== "IN_PROGRESS") return res.status(409).json({ error: "Session is not editable" })

    const ruleQ = await pool.query(
      `
      SELECT rule_title, guidance_text, example_text
      FROM compliance_rule
      WHERE lower(trim(spirit_type)) = lower(trim($1))
        AND rule_code = $2
        AND rule_version = $3
        AND active = true
      LIMIT 1
      `,
      [session.spirit_type, ruleCode, ruleVersion]
    )

    if (ruleQ.rowCount === 0) {
      return res.status(422).json({ error: "Rule not found or inactive for this spirit type/version" })
    }

    const rule = ruleQ.rows[0]

    const ins = await pool.query(
      `
      INSERT INTO compliance_review_event
        (session_id, rule_code, rule_version, rule_title, guidance_text, sample_reference, decision, reviewer_comment)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, session_id, rule_code, rule_version, rule_title, decision, reviewer_comment, created_at
      `,
      [
        sessionId,
        ruleCode,
        ruleVersion,
        rule.rule_title,
        rule.guidance_text,
        rule.example_text || null,
        decision,
        reviewerComment,
      ]
    )

    res.json({ ok: true, event: ins.rows[0] })
  } catch (e) {
    next(e)
  }
})

// -------------------------
// Finalize + Gate
// -------------------------

/**
 * POST /api/compliance/review/finalize
 * Body: { sessionId }
 * Requires that every active rule for the session spirit_type has a decision.
 */
router.post("/review/finalize", async (req, res, next) => {
  try {
    const sessionId = requiredInt("sessionId", req.body.sessionId)

    const sessionQ = await pool.query(
      `SELECT id, spirit_type, status FROM compliance_review_session WHERE id = $1`,
      [sessionId]
    )
    if (sessionQ.rowCount === 0) return res.status(404).json({ error: "Session not found" })

    const session = sessionQ.rows[0]
    if (session.status !== "IN_PROGRESS") return res.status(409).json({ error: "Session is already finalized" })

   const rulesQ = await pool.query(
     `
     SELECT rule_code, rule_version
     FROM compliance_rule
     WHERE lower(trim(spirit_type)) = lower(trim($1))
       AND active = true
     `,
     [session.spirit_type]
     )


    const eventsQ = await pool.query(
      `SELECT DISTINCT rule_code, rule_version FROM compliance_review_event WHERE session_id = $1`,
      [sessionId]
    )

    const have = new Set(eventsQ.rows.map((r) => `${r.rule_code}@@${r.rule_version}`))
    const missing = rulesQ.rows
      .filter((r) => !have.has(`${r.rule_code}@@${r.rule_version}`))
      .map((r) => ({ ruleCode: r.rule_code, ruleVersion: r.rule_version }))

    if (missing.length > 0) {
      return res.status(422).json({
        error: "Cannot finalize: missing decisions for required rules",
        missing,
      })
    }

    const upd = await pool.query(
      `
      UPDATE compliance_review_session
      SET status = 'FINALIZED', finalized_at = now()
      WHERE id = $1
      RETURNING id, status, finalized_at
      `,
      [sessionId]
    )

    res.json({ ok: true, session: upd.rows[0] })
  } catch (e) {
    next(e)
  }
})

/**
 * GET /api/compliance/review/status?labelHistoryId=16
 */
router.get("/review/status", async (req, res, next) => {
  try {
    const labelHistoryId = requiredInt("labelHistoryId", req.query.labelHistoryId)

    const q = await pool.query(
      `
      SELECT finalized_at
      FROM compliance_review_session
      WHERE label_history_id = $1 AND status = 'FINALIZED'
      ORDER BY finalized_at DESC, id DESC
      LIMIT 1
      `,
      [labelHistoryId]
    )

    res.json({
      ok: true,
      hasFinalizedReview: q.rowCount > 0,
      finalizedAt: q.rowCount > 0 ? q.rows[0].finalized_at : null,
    })
  } catch (e) {
    next(e)
  }
})

// ---- error handler (router-local) ----
router.use((err, _req, res, _next) => {
  console.error("[compliance router error]", err)
  res.status(err.status || 500).json({ error: err.message || "Server error" })
})

module.exports = router

