import OpenAI from "openai";

/* --------------------------- small helpers --------------------------- */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const moneyNum = (s) => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "$—");

function heuristic(payload) {
  const base = 35000;
  const lenAdj = (Number(payload.length) || 0) * 900;
  const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
  const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
  const factor = condMap[payload.condition] || 1;
  const est = Math.round(((base + lenAdj + yearAdj) * factor) / 100) * 100;

  const comps = Array.from({ length: 6 }).map((_, i) => ({
    title: `${payload.make || "Boat"} ${payload.model || ""}`.trim(),
    year: payload.year || 2016 + ((i % 6) - 2),
    length: payload.length || 22,
    price: money(est * (0.92 + i * 0.02)),
    location: payload.location || "Local Market",
    url: "https://hullify.net",
  }));

  const trend = Array.from({ length: 12 }).map((_, i) => ({
    label: new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11 + i, 1)
    ).toLocaleString("en-US", { month: "short" }),
    price: Math.round(est * (0.92 + 0.16 * (i / 11)) ),
  }));

  return {
    estimate: money(est),
    range: { low: money(est * 0.97), high: money(est * 1.03) },
    confidence: "medium",
    rationale:
      "Heuristic model based on size, year and condition; tuned conservatively for current demand.",
    comps,
    trend, // UI ignores this unless needed; fine to include
  };
}

async function getValuation(payload, includeTrend) {
  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You are a marine pricing assistant. Return JSON ONLY with keys: estimate (\"$68,500\"), range:{low,high}, confidence (low|medium|high), rationale, comps:[{title,price,year,length,location,url}], trend:[{label,price}] when requested.",
        },
        { role: "user", content: JSON.stringify({ ...payload, requestTrend: includeTrend }) },
      ],
    });

    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    const estN = moneyNum(parsed.estimate);
    if (!estN) return heuristic(payload);

    if (!Array.isArray(parsed.comps) || parsed.comps.length === 0) {
      parsed.comps = heuristic(payload).comps;
    }
    if (includeTrend && (!Array.isArray(parsed.trend) || parsed.trend.length < 6)) {
      parsed.trend = heuristic(payload).trend;
    }
    return parsed;
  } catch (e) {
    console.error("estimate AI error:", e);
    return heuristic(payload);
  }
}

/* --------------------------------- API -------------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const payload = req.body || {};
    const includeTrend = false; // UI doesn't need trend here; PDF route does
    const valuation = await getValuation(payload, includeTrend);
    res.status(200).json(valuation);
  } catch (err) {
    console.error("estimate error:", err);
    res.status(500).json({ error: "Failed to create estimate" });
  }
}
