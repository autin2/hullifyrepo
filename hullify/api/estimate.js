import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function fallbackEstimate(payload) {
  const base = 35000;
  const lenAdj = (Number(payload.length) || 0) * 900;
  const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
  const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
  const factor = condMap[payload.condition] || 1;
  const est = Math.round((base + lenAdj + yearAdj) * factor / 100) * 100;
  return {
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

  try {
    const payload = req.body || {};

    const messages = [
      {
        role: "system",
        content:
          "You are a marine pricing assistant. Return ONLY JSON with keys: estimate (string like $68,500), range.low, range.high, confidence (low|medium|high), rationale (1–2 sentences). Be conservative and adjust strongly for overall condition."
      },
      { role: "user", content: JSON.stringify(payload) }
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let data;
    try { data = JSON.parse(content); } catch { data = fallbackEstimate(payload); }
    if (!data.estimate) data = fallbackEstimate(payload);

    res.status(200).json(data);
  } catch (err) {
    console.error("estimate error:", err);
    res.status(200).json(fallbackEstimate(req.body || {}));
  }
}
