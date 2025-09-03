// /api/_valuation.js
import OpenAI from "openai";

/**
 * AI-first valuation with tight, predictable ranges.
 * - Primary: OpenAI JSON output
 * - Guard: clamp estimate to a reasonable band vs. baseline
 * - Range: enforce width by confidence (±8/12/18%) with $800 absolute floor
 */

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const nowYear = new Date().getFullYear();

// ---- tuning knobs (edit to taste) ----
const RANGE_WIDTH = { high: 0.08, medium: 0.12, low: 0.18 };   // ±%
const ABS_MIN_SPREAD_DOLLARS = 800;                             // min half-width in $
const CLAMP_BAND = { low: 0.50, high: 1.60 };                   // est vs baseline band

function num(x, d = null) { const n = Number(x); return Number.isFinite(n) ? n : d; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function money(n) { return `$${Math.round(n).toLocaleString()}`; }
function moneyNum(s) { if (!s) return null; const n = Number(String(s).replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : null; }

/** Baseline guard (not displayed) — used only to keep AI in-bounds if it goes wild. */
function baselineGuard(payload = {}) {
  const L = clamp(num(payload.length, 20), 8, 60);
  const Y = clamp(num(payload.year, 2005), 1950, nowYear + 1);
  const age = Math.max(0, nowYear - Y);

  let base = 1200 * Math.pow(Math.max(10, Math.min(L, 55)), 1.22);
  let dep = 0;
  if (age <= 5) dep = 0.07 * age;
  else if (age <= 20) dep = 0.35 + 0.04 * (age - 5);
  else dep = 0.95;
  base *= (1 - Math.min(dep, 0.95));

  const condF = ({ Excellent: 1.12, Good: 1.0, Fair: 0.70, "Needs Work": 0.45 }[payload.condition]) || 1.0;
  base *= condF;

  const runsF = ({ "Yes": 1.0, "Starts but stalls": 0.75, "No": 0.55 }[payload.runs]) || 1.0;
  base *= runsF;

  const hours = num(payload.engineHours, 0);
  if (hours > 800) {
    const penalty = Math.min(0.40, ((hours - 800) / 1000) * 0.25);
    base *= (1 - penalty);
  } else if (hours > 0 && hours < 200 && (payload.condition === "Excellent" || payload.condition === "Good")) {
    base *= 1.03;
  }

  if (payload.outOfWaterYearPlus) base *= 0.90;

  const trailerAdj = L <= 18 ? 800 : L <= 24 ? 1500 : L <= 30 ? 2500 : 3500;
  if (payload.trailer === "Yes") base += Math.round(trailerAdj * 0.4);
  else if (payload.trailer === "No") base -= trailerAdj;

  const ts = payload.titleStatus;
  if (ts === "Bill of Sale only") base *= 0.85;
  else if (ts === "Other") base *= 0.95;
  else if (ts === "Loan/Lien") base *= 0.98;

  const hm = String(payload.hullMaterial || "").toLowerCase();
  if (hm === "wood") base *= 0.85;
  if (hm === "steel") base *= 0.92;

  return Math.max(500, Math.round(base));
}

function rationaleFrom(payload, age) {
  const bits = [
    `${age}-yr age`, `${payload.length || "—"} ft`,
    `condition: ${payload.condition || "unknown"}`,
    payload.runs ? `runs: ${String(payload.runs).toLowerCase()}` : null,
    payload.engineHours ? `${payload.engineHours} hours` : null,
    payload.trailer ? `trailer: ${payload.trailer}` : null,
    payload.outOfWaterYearPlus ? "stored out of water 1+ yr" : null,
    payload.titleStatus ? `title: ${payload.titleStatus}` : null,
  ].filter(Boolean);
  return `AI valuation adjusted for ${bits.join(", ")}.`;
}

/** Enforce a narrow, symmetric range around the estimate. */
function enforceRange(est, proposedLow, proposedHigh, confidence, ugly) {
  // Choose target half-width %
  let target = RANGE_WIDTH.medium;
  if (confidence === "high") target = RANGE_WIDTH.high;
  else if (confidence === "low" || ugly) target = RANGE_WIDTH.low;

  // Convert to dollars and apply absolute floor
  let half = Math.max(Math.round(est * target), ABS_MIN_SPREAD_DOLLARS);

  // If AI gave a narrower *and* valid range, keep it; otherwise tighten.
  if (Number.isFinite(proposedLow) && Number.isFinite(proposedHigh) && proposedLow <= est && proposedHigh >= est) {
    const aiHalf = Math.max(est - proposedLow, proposedHigh - est);
    const aiPercent = aiHalf / est;
    const maxAllowed = target;                         // don't allow wider than target
    const minAllowed = Math.max(ABS_MIN_SPREAD_DOLLARS / est, 0.04);
    if (aiPercent <= maxAllowed && aiPercent >= minAllowed) {
      return { low: Math.round(proposedLow), high: Math.round(proposedHigh) };
    }
  }

  // Build symmetric range around estimate
  const low = Math.max(500, Math.round(est - half));
  const high = Math.round(est + half);
  return { low, high };
}

export async function computeValuation(payload = {}, { includeTrend = false } = {}) {
  const L = clamp(num(payload.length, 20), 8, 60);
  const Y = clamp(num(payload.year, 2005), 1950, nowYear + 1);
  const age = Math.max(0, nowYear - Y);

  // 1) Baseline + clamp band
  const guard = baselineGuard(payload);
  const bandLow = Math.max(500, Math.round(guard * CLAMP_BAND.low));
  const bandHigh = Math.round(guard * CLAMP_BAND.high);

  // 2) Call OpenAI for primary estimate
  let ai = null;
  if (client) {
    try {
      const messages = [
        {
          role: "system",
          content:
`You are a marine valuation model. Return STRICT JSON ONLY with keys:
- estimate: string like "$18,500"
- range: { low: "$xx,xxx", high: "$yy,yyy" }  // low <= estimate <= high
- confidence: "low" | "medium" | "high"
- rationale: short one-sentence reason
- comps: array (<=8) of { title, price, year, length, location, url }
- trend: optional array 12 months [{label, price}] ONLY if requestTrend = true

Adjustment guidance (downward pressure):
- condition: "Fair" or "Needs Work" → strong negative
- runs: "No" or "Starts but stalls" → strong negative
- engineHours > 800 (and especially >1500) → negative
- outOfWaterYearPlus = true → negative
- trailer: "No" → subtract typical trailer value by size
- titleStatus "Bill of Sale only" → strong negative; "Other" → mild negative
- very old (>20 yrs) → conservative

RANGE DISCIPLINE:
- Keep (high - low) relatively tight: 
  high/low ratio should usually be <= 1.25.
- Prefer symmetric ranges around the estimate when reasonable.
Return JSON only.`
        },
        { role: "user", content: JSON.stringify({ ...payload, requestTrend: includeTrend }) },
      ];

      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages,
      });

      ai = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      console.error("OpenAI error (valuation):", e);
      ai = null;
    }
  }

  // 3) Estimate from AI (or baseline), clamped to band
  let est = ai ? moneyNum(ai.estimate) : null;
  if (!est || !Number.isFinite(est)) est = guard;
  est = clamp(est, bandLow, bandHigh);

  // 4) Confidence
  const ugly = (payload.condition === "Needs Work") || (payload.runs !== "Yes") ||
               !!payload.outOfWaterYearPlus || payload.titleStatus === "Bill of Sale only";
  let confidence = ai?.confidence && ["low","medium","high"].includes(String(ai.confidence).toLowerCase())
    ? String(ai.confidence).toLowerCase()
    : (ugly ? "low" : "medium");

  // 5) Range — enforce width around estimate
  const aiLow = ai?.range ? moneyNum(ai.range.low) : null;
  const aiHigh = ai?.range ? moneyNum(ai.range.high) : null;
  const enforced = enforceRange(est, aiLow, aiHigh, confidence, ugly);
  const low = enforced.low;
  const high = enforced.high;

  // 6) Comps (AI or synthetic)
  const title = `${payload.make || "Boat"} ${payload.model || ""}`.trim();
  const comps = Array.isArray(ai?.comps) && ai.comps.length
    ? ai.comps.slice(0, 8)
    : Array.from({ length: 6 }).map((_, i) => ({
        title,
        year: payload.year || (nowYear - (6 - i)),
        length: payload.length || L,
        price: money(Math.round(est * (0.90 + i * 0.03))),
        location: payload.location || "Local Market",
        url: "https://hullify.net",
      }));

  // 7) Trend (optional)
  let trend;
  if (includeTrend) {
    trend = Array.isArray(ai?.trend) && ai.trend.length >= 6
      ? ai.trend
      : Array.from({ length: 12 }).map((_, i) => {
          const d = new Date(Date.UTC(nowYear, new Date().getUTCMonth() - 11 + i, 1));
          const price = Math.round(est * (0.90 + (i / 11) * 0.15));
          return { label: d.toLocaleString("en-US", { month: "short" }), price };
        });
  }

  const listingTitle = `${payload.year || ""} ${title} • ${L || "—"} ft`.replace(/\s+/g, " ").trim();
  const descBits = [];
  if (payload.length) descBits.push(`Approximately ${L}’`);
  if (payload.make) descBits.push(payload.make);
  if (payload.model) descBits.push(payload.model);
  if (payload.year) descBits.push(`(${Y})`);
  descBits.push(`${payload.condition || "Good"} condition.`);
  if (payload.runs) descBits.push(`Runs: ${payload.runs}.`);
  if (payload.engineHours) descBits.push(`Engine hours: ${payload.engineHours}.`);
  if (payload.engine) descBits.push(`Engine: ${payload.engine}.`);
  if (payload.trailer === "Yes") descBits.push("Trailer included.");
  if (payload.aftermarket) descBits.push(`Upgrades: ${payload.aftermarket}.`);
  if (payload.outOfWaterYearPlus) descBits.push("Stored out of water 1+ year.");
  const listingDescription = descBits.join(" ").replace(/\s+/g, " ");

  return {
    estimate: money(est),
    range: { low: money(low), high: money(high) },
    confidence,
    rationale: ai?.rationale || rationaleFrom(payload, age),
    comps,
    listingTitle,
    listingDescription,
    negotiationBullets: [
      "AI-adjusted for age, running status & hours",
      payload.trailer === "Yes" ? "Trailer included" : "No trailer — price reflects",
      "Local-market comparable pricing",
    ],
    prepChecklist: [
      "Deep clean hull & deck; remove personal items",
      "Fresh photos: bow, helm, engine(s), trailer (if any)",
      "Have maintenance receipts handy",
    ],
    upgradeTips: [
      "Address inexpensive mechanical issues before listing",
      "Detailing & minor upholstery fixes often 2–5× ROI",
    ],
    ...(includeTrend ? { trend } : {}),
  };
}
