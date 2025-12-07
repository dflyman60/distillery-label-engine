// src/routes/labels.js
const express = require("express");
const router = express.Router();
const openai = require("../openaiClient");

// POST /api/labels/generate
router.post("/generate", async (req, res) => {
  try {
    const {
      productName,
      spiritType,
      flavorNotes,
      abv,
      volumeMl,
      brandName,
      brandStory,
      tone,
      region,
      additionalNotes,
    } = req.body;

    if (!productName || !spiritType || !abv || !volumeMl || !brandName) {
      return res.status(400).json({
        error:
          "Missing required fields: productName, spiritType, abv, volumeMl, brandName",
      });
    }

    const systemPrompt = `
You are an expert craft-spirits copywriter and TTB-aware label consultant.
You write concise, compelling front-label titles and rich but compliant back-label copy
for American distilleries.

Rules:
- Use the provided ABV and volume only.
- No health claims or intoxication promises.
- No profanity.
- Avoid statements conflicting with TTB norms.
`;

    const userPrompt = `
Create label copy for this spirit.

DATA (JSON):
{
  "brandName": "${brandName}",
  "productName": "${productName}",
  "spiritType": "${spiritType}",
  "flavorNotes": "${flavorNotes || ""}",
  "abv": ${abv},
  "volumeMl": ${volumeMl},
  "brandStory": "${brandStory || ""}",
  "tone": "${tone || "heritage"}",
  "region": "${region || ""}",
  "additionalNotes": "${additionalNotes || ""}"
}

Return a single JSON object with EXACTLY these fields:
- "frontLabel"
- "backLabel"
- "complianceBlock"

Use proof = abv * 2, and include ABV, proof, and volume in the compliance block.
Respond with ONLY JSON. No backticks, no commentary.
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "";

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

    return res.json({
      productName,
      spiritType,
      label: parsed,
    });

  } catch (err) {
    console.error("Error generating label:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err.message || String(err),
    });
  }
});

// ✅ Critical: export the router itself
module.exports = router;

