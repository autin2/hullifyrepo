// /api/_valuation.js
import OpenAI from "openai";

/**
 * AI-first valuation with safety guards.
 * - Primary: OpenAI JSON output
 * - Fallback: heuristic guard if AI fails
 * - Clamp: keep AI within a reasonable band so it can't return wild numbers
 */

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const nowYear = new Date().getFullYear();

function num(x, d = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function money(n) { return `$${Math.round(n).toLocaleString()}`; }
function moneyNum(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** A small baseline model used ONLY as guardrails/fallback, not as the primary price. */
function baselineGuard(payload = {}) {
  const L = clamp(num(payload.length, 20), 8, 60);
  const Y = clamp(num(payload.year, 2005), 1950, nowYear + 1);
  const age = Math.max(0, nowYear - Y);

  let base = 1200 * Math.pow(Math.max(10, Math.min(L, 55)), 1.22);

  let dep = 0;
  if (age <= 5)        dep = 0.07 * age;
  else if (age <= 20)  dep = 0.35 + 0.04 * (age - 5);
  else                 dep = 0.95;
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

  const Lval = L;
  const trailerAdj = Lval <= 18 ? 800 : Lval <= 24 ? 1500 : Lval <= 30 ? 2500 : 3500;
  if (payload.trailer === "Yes") base += Math.round(trailerAdj * 0.4);
  else if (payload.trailer === "No") base -= trailerAdj;

  const ts = payload.titleStatus;
  if (ts === "Bill of Sale only") base *= 0.85;
  else if (ts === "Other")        base *= 0.95;
  else if (ts === "Loan/Lien")    base *= 0.98;

  const hm = String(payload.hullMaterial || "").toLowerCase();
  if (hm === "wood")  base *= 0.85;
  if (hm === "steel") base *= 0.92;

  base = Math.max(500, base);
  return Math.round(base);
}

/** Compose a clean rationale sentence */
function rationaleFrom(payload, age) {
  const bits = [
    `${age}-yr age`, `${payload.length || "—"} ft`,
    `condition: ${payload.condition || "unknown"}`,
    payload.runs ? `runs: ${payload.runs.toLowerCase()}` : null,
    payload.engineHours ? `${payload.engineHours} hours` : null,
    payload.trailer ? `trailer: ${payload.trailer}` : null,
    payload.outOfWaterYearPlus ? "stored out of water 1+ yr" : null,
    payload.titleStatus ? `title: ${payload.titleStatus}` : null,
  ].filter(Boolean);
  return `AI valuation adjusted for ${bits.join(", ")}.`;
}

/**
 * Main entry point used by both /api/estimate and /api/pdf.
 * Price comes from AI if possible; otherwise we fall back to the baseline guard.
 * We also clamp AI's number to a band around the baseline to prevent absurd results.
 */
export async function computeValuation(payload = {}, { includeTrend = false } = {}) {
  const L = clamp(num(payload.length, 20), 8, 60);
  const Y = clamp(num(payload.year, 2005), 1950, nowYear + 1);
  const age = Math.max(0, nowYear - Y);

  // 1) Baseline guard and clamp band
  const guard = baselineGuard(payload);
  const bandLow  = Math.max(500, Math.round(guard * 0.5)); // allow low 50% of baseline
  const bandHigh = Math.round(guard * 1.6);                // allow high 160% of baseline

  // 2) Try AI
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
- trend: optional array 12 months [{label, price}] ONLY if user requested trend

Important adjustment rules (downward pressure):
- "Needs Work" or "Fair": cut hard.
- runs = "No" or "Starts but stalls": strong negative multipliers.
- engineHours > 800: penalize; >1500: heavy penalty.
- outOfWaterYearPlus = true: negative adjustment.
- trailer = "No": subtract typical trailer value for the size.
- titleStatus "Bill of Sale only": strong penalty; "Other": small negative.
- Very old (>20y): be conservative.
- Prefer lower valuations when multiple negatives stack.

Do NOT produce any text outside JSON.`
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

  // 3) If AI failed or missing estimate, use guard-only
  let est = ai ? moneyNum(ai.estimate) : null;
  if (!est || !Number.isFinite(est)) est = guard;

  // 4) Clamp AI output into a reasonable band
  est = clamp(est, bandLow, bandHigh);

  // 5) Build outputs (use AI when present, with fixes)
  let low = ai && ai.range ? moneyNum(ai.range.low) : null;
  let high = ai && ai.range ? moneyNum(ai.range.high) : null;

  // Ensure sensible range around (clamped) estimate
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
    const spread = (payload.condition === "Needs Work" || payload.runs !== "Yes" || payload.outOfWaterYearPlus || payload.titleStatus === "Bill of Sale only") ? 0.22 : 0.12;
    low = Math.max(500, Math.round(est * (1 - spread)));
    high = Math.round(est * (1 + spread));
  } else {
    // Keep AI's range but ensure it envelopes the clamped estimate
    low = Math.min(low, est);
    high = Math.max(high, est);
  }

  // Comps
  const title = `${payload.make || "Boat"} ${payload.model || ""}`.trim();
  let comps = Array.isArray(ai?.comps) && ai.comps.length
    ? ai.comps.slice(0, 8)
    : Array.from({ length: 6 }).map((_, i) => ({
        title,
        year: payload.year || (nowYear - (6 - i)),
        length: payload.length || L,
        price: money(Math.round(est * (0.90 + i * 0.03))),
        location: payload.location || "Local Market",
        url: "https://hullify.net",
      }));

  // Trend
  let trend = includeTrend
    ? (Array.isArray(ai?.trend) && ai.trend.length >= 6
        ? ai.trend
        : Array.from({ length: 12 }).map((_, i) => {
            const d = new Date(Date.UTC(nowYear, new Date().getUTCMonth() - 11 + i, 1));
            const price = Math.round(est * (0.90 + (i / 11) * 0.15));
            return { label: d.toLocaleString("en-US", { month: "short" }), price };
          }))
    : undefined;

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

  const ugly = (payload.condition === "Needs Work") || (payload.runs !== "Yes") ||
               !!payload.outOfWaterYearPlus || payload.titleStatus === "Bill of Sale only";
  const confidence =
    ai?.confidence && ["low", "medium", "high"].includes(String(ai.confidence).toLowerCase())
      ? String(ai.confidence).toLowerCase()
      : ugly ? "low" : "medium";

  const negotiationBullets = [
    "AI-adjusted for age, running status & hours",
    payload.trailer === "Yes" ? "Trailer included" : "No trailer — price reflects",
    "Local-market comparable pricing",
  ];
  const prepChecklist = [
    "Deep clean hull & deck; remove personal items",
    "Fresh photos: bow, helm, engine(s), trailer (if any)",
    "Have maintenance receipts handy",
  ];
  const upgradeTips = [
    "Address inexpensive mechanical issues before listing",
    "Detailing & minor upholstery fixes often 2–5× ROI",
  ];

  return {
    estimate: money(est),
    range: { low: money(low), high: money(high) },
    confidence,
    rationale: ai?.rationale || rationaleFrom(payload, age),
    comps,
    listingTitle,
    listingDescription,
    negotiationBullets,
    prepChecklist,
    upgradeTips,
    ...(includeTrend ? { trend } : {}),
  };
}
