// api/estimate.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fallbackEstimate(payload = {}) {
  const base = 35000;
  const lenAdj = (Number(payload.length) || 0) * 900;
  const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
  const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
  const factor = condMap[payload.condition] || 1;
  const est = Math.round(((base + lenAdj + yearAdj) * factor) / 100) * 100;
  return {
    estimateNumber: est,
    estimate: `$${est.toLocaleString()}`,
    range: {
      low: `$${Math.round(est * 0.97).toLocaleString()}`,
      high: `$${Math.round(est * 1.03).toLocaleString()}`
    },
    confidence: "medium",
    rationale: "Fallback heuristic used due to temporary AI issue."
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  // Normalize body (Vercel sometimes gives string)
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const payload = body || {};

  try {
    // Compose system prompt and user content
    const messages = [
      {
        role: "system",
        content: "You are a valuation assistant. Return STRICT JSON with keys: estimate (string like $45,000), range.low, range.high, confidence (one of low|medium|high), rationale (short string). Be conservative and use current US resale market tone. Do not include extra keys."
      },
      {
        role: "user",
        content:
          `Estimate a used boat with these fields (JSON): ` +
          JSON.stringify({
            make: payload.make || null,
            model: payload.model || null,
            year: payload.year || null,
            length: payload.length || null,
            condition: payload.condition || null,
            hours: payload.hours || null,
            engine: payload.engine || null,
            trailer: payload.trailer || null,
            fuel: payload.fuel || null,
            storage: payload.storage || null,
            upgrades: payload.upgrades || null,
            details: payload.details || null,
            outOfWaterYearPlus: payload.outOfWaterYearPlus || null,
            location: payload.location || null
          })
      }
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let data;
    try { data = JSON.parse(content); } catch { data = fallbackEstimate(payload); }

    // If AI forgot fields, patch with fallback while keeping AI's estimate if parseable
    if (!data || !data.estimate) data = fallbackEstimate(payload);

    // Optionally add numeric estimateNumber for downstream use
    const num = Number(String(data.estimate || "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(num)) data.estimateNumber = Math.round(num);

    res.status(200).json(data);
  } catch (err) {
    console.error("estimate error:", err);
    res.status(200).json(fallbackEstimate(payload));
  }
}
