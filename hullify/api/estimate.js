// /api/estimate.js
import { computeValuation } from "./_valuation.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const payload = await readJsonBody(req);

  try {
    const valuation = await computeValuation(payload, { includeTrend: false });
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
