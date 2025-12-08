// src/routes/labels.js
const express = require("express");
const router = express.Router();

const openai = require("../openaiClient");
const db = require("../db");

// POST /api/labels/generate
router.post("/generate", async (req, res) => {
  try {
    const {
      brandName,
      productName,
      spiritType,
      abv,
      volumeMl,
      tone,
      region,
      flavorNotes,
      story,
      brandStory,
      additionalNotes,
    } = req.body || {};

    // Basic validation for required fields
    if (!brandName || !productName || !spiritType || !abv || !volumeMl) {
      return res.status(400).json({
        error:
          "Missing required fields: brandName, productName, spiritType, abv, volumeMl are required.",
      });
    }

    const narrativeStory = brandStory || story || "";

    const systemPrompt = `
You are an expert craft-spirits label copywriter who understands both marketing and TTB compliance.
You will receive a brief about a spirit and must return JSON with three fields:

{
  "frontLabel": "...",
  "backLabel": "...",
  "complianceBlock": "..."
}

- "frontLabel": short, punchy hero text suitable for the front label.
- "backLabel": longer story / tasting notes suitable for the back label, 80–140 words.
- "complianceBlock": highly compressed, compliance-focused block that includes:
  - brand name
  - product type
  - ABV (% Alc/Vol)
  - volume (ml)
  - origin / region phrasing if provided
Return ONLY valid JSON. No commentary.
`;

    const userPrompt = `
Brand: ${brandName}
Product: ${productName}
Spirit type: ${spiritType}
ABV: ${abv}%
Volume: ${volumeMl} ml
Tone: ${tone || "not specified"}
Region: ${region || "not specified"}
Flavor notes: ${flavorNotes || "not specified"}
Story / brand background: ${narrativeStory || "none provided"}
Additional notes: ${additionalNotes || "none"}
`;

    // 🔮 Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("Error parsing JSON from OpenAI:", e, raw);
      return res.status(500).json({
        error: "Failed to parse label JSON from OpenAI",
        raw,
      });
    }

    const frontLabel = parsed.frontLabel || parsed.front_label || "";
    const backLabel = parsed.backLabel || parsed.back_label || "";
    const complianceBlock =
      parsed.complianceBlock || parsed.compliance_block || "";

    // 🗄️ Save to Postgres (INSIDE the async handler – safe to use await)
    try {
      await db.query(
        `
        INSERT INTO labels (
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
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          brandName,
          productName,
          spiritType,
          abv,
          volumeMl,
          tone || null,
          flavorNotes || null,
          region || null,
          narrativeStory || null,
          additionalNotes || null,
          frontLabel,
          backLabel,
          complianceBlock,
        ]
      );
    } catch (dbErr) {
      console.error("Error inserting label into DB:", dbErr);
      // Non-fatal: we still return the generated label
    }

    return res.json({
      brandName,
      productName,
      spiritType,
      abv,
      volumeMl,
      tone,
      region,
      flavorNotes,
      brandStory: narrativeStory,
      additionalNotes,
      label: {
        frontLabel,
        backLabel,
        complianceBlock,
      },
    });
  } catch (err) {
    console.error("Unexpected error in /generate:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/labels/history?limit=20
router.get("/history", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);

  try {
    const { rows } = await db.query(
      `
      SELECT
        id,
        brand_name       AS "brandName",
        product_name     AS "productName",
        spirit_type      AS "spiritType",
        abv,
        volume_ml        AS "volumeMl",
        tone,
        flavor_notes     AS "flavorNotes",
        region,
        brand_story      AS "brandStory",
        additional_notes AS "additionalNotes",
        front_label      AS "frontLabel",
        back_label       AS "backLabel",
        compliance_block AS "complianceBlock",
        created_at       AS "createdAt"
      FROM labels
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return res.json({ items: rows });
  } catch (err) {
    console.error("Error fetching label history:", err);
    return res.status(500).json({ error: "Failed to load history" });
  }
});

module.exports = router;

