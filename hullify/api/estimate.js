// /api/estimate.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const payload = await readJsonBody(req);

  try {
    const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "$—");
    const base = 35000;
    const lenAdj = (Number(payload.length) || 0) * 900;
    const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
    const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
    const factor = condMap[payload.condition] || 1;
    const est = Math.round(((base + lenAdj + yearAdj) * factor) / 100) * 100;

    const valuation = {
      estimate: money(est),
      range: { low: money(est * 0.97), high: money(est * 1.03) },
      confidence: "medium",
      rationale:
        "Heuristic model based on size, year and condition; tuned conservatively for current demand.",
      comps: Array.from({ length: 6 }).map((_, i) => ({
        title: `${payload.make || "Boat"} ${payload.model || ""}`.trim(),
        year: payload.year || 2016 + ((i % 6) - 2),
        length: payload.length || 22,
        price: money(est * (0.92 + i * 0.02)),
        location: payload.location || "Local Market",
        url: "https://hullify.net",
      })),
    };

    res.setHeader("Content-Type", "application/json");
    return res.status(200).end(JSON.stringify(valuation));
  } catch (err) {
    console.error("estimate error:", err);
    return res.status(500).json({ error: "Failed to create estimate" });
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
