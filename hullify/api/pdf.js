// api/pdf.js
import OpenAI from "openai";
import PDFDocument from "pdfkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* --------------------------- small helpers --------------------------- */
const moneyNum = (s) => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "$—");


const toNumber = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const normalizeValuation = (v) => {
  if (!v) return null;
  const estNum = v.estimateNumber ?? toNumber(v.estimate);
  if (!Number.isFinite(estNum)) return null;
  const est = Math.round(estNum / 100) * 100;
  const lowN = v.range?.low ? toNumber(v.range.low) : Math.round(est * 0.97);
  const highN = v.range?.high ? toNumber(v.range.high) : Math.round(est * 1.03);
  return {
    estimateNumber: est,
    estimate: `$${est.toLocaleString()}`,
    range: { low: `$${Math.round(lowN).toLocaleString()}`, high: `$${Math.round(highN).toLocaleString()}` },
    confidence: v.confidence || v.confidenceScore || null,
    rationale: v.rationale || v.notes || null,
    comps: Array.isArray(v.comps) ? v.comps : undefined
  };
};

function heuristic(payload) {
  const base = 35000;
  const lenAdj = (Number(payload.length) || 0) * 900;
  const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
  const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
  const factor = condMap[payload.condition] || 1;
  const estNum = Math.round(((base + lenAdj + yearAdj) * factor) / 100) * 100;

  const comps = [
    { title: "Local listing A", price: money(estNum * 0.98), url: "", meta: "Similar size/age" },
    { title: "Local listing B", price: money(estNum * 1.02), url: "", meta: "Similar size/age" },
    { title: "Recent sale C",   price: money(estNum * 0.95), url: "", meta: "Recent comp" },
  ];

  return {
    estimate: money(estNum),
    range: { low: money(estNum * 0.97), high: money(estNum * 1.03) },
    confidence: "medium",
    rationale:
      "Heuristic model based on size, year and condition; tuned conservatively for current demand.",
    comps,
    listingTitle: `${payload.year || ""} ${payload.make || ""} ${payload.model || ""} • ${
      payload.length || "—"
    } ft`
      .replace(/\s+/g, " ")
      .trim(),
    listingDescription: `Well-kept ${payload.length || "—"}’ ${payload.make || "boat"} ${
      payload.model || ""
    } (${payload.year || "unknown year"})
${payload.engine ? `Engine: ${payload.engine}` : ""}${
      payload.hours ? ` • ${payload.hours} hrs` : ""
    }${payload.trailer ? " • Includes trailer" : ""}

${payload.upgrades ? `Upgrades: ${payload.upgrades}` : ""}

${payload.details || ""}`.trim()
  };
}

async function getValuation(payload, includeTrend = true) {
  // Try AI first, fallback to heuristic
  try {
    const messages = [
      {
        role: "system",
        content:
          "You write concise JSON fields for a used-boat valuation report. Keys: estimate ($12,300), range.low, range.high, confidence (low|medium|high), rationale (short, one sentence), comps (array of objects with title, price, url, meta), listingTitle, listingDescription. Keep numbers realistic and conservative."
      },
      {
        role: "user",
        content:
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
            location: payload.location || null,
          })
      }
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages
    });

    const text = resp.choices?.[0]?.message?.content || "{}";
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    if (!data.estimate) data = {};

    // Ensure minimum fields
    if (!data.estimate) {
      data = heuristic(payload);
    }
    return data;
  } catch (e) {
    return heuristic(payload);
  }
}

/* --------------------------- PDF builder --------------------------- */
const COLORS = {
  bg: "#FFFFFF",
  ink: "#0c1b2a",
  primary: "#1446A0",
  muted: "#58708C",
  soft: "#E9EEF5",
  success: "#198754",
  chip: "#F5F8FF",
  dark: "#1A2A3A",
};

function textBlock(doc, text, x, y, width, options = {}) {
  const {
    size = 10,
    color = COLORS.ink,
    lineGap = 3,
    align = "left",
    leading = 1.2,
    bold = false,
  } = options;

  if (bold) doc.font("Helvetica-Bold");
  else doc.font("Helvetica");

  doc
    .fillColor(color)
    .fontSize(size)
    .text(text, x, y, { width, align, lineGap, continued: false });

  const { y: yAfter } = doc;
  return yAfter;
}

function header(doc, title) {
  doc.rect(0, 0, doc.page.width, 100).fill(COLORS.chip);
  doc.fillColor(COLORS.primary).font("Helvetica-Bold").fontSize(20).text("Hullify", 40, 28);
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(16).text(title, 40, 60);
  doc.fillColor(COLORS.ink);
}

function drawChip(doc, label, x, y) {
  const paddingX = 8, paddingY = 4;
  const w = doc.widthOfString(label) + paddingX * 2;
  const h = doc.currentLineHeight() + paddingY * 2;
  doc.roundedRect(x, y, w, h, 8).fill(COLORS.chip);
  doc.fillColor(COLORS.primary).text(label, x + paddingX, y + paddingY);
  doc.fillColor(COLORS.ink);
  return { w, h };
}

async function buildPdf(payload, valuation, includeTrend = true) {
  const doc = new PDFDocument({ size: "LETTER", margin: 40 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));
  doc.on("end", () => {});

  const margins = { left: 40, top: 112, right: 40, bottom: 40 };
  const usableW = doc.page.width - margins.left - margins.right;

  // Header
  header(doc, "Boat Valuation Report");

  // Summary group
  let y = margins.top;
  const leftColW = Math.floor(usableW * 0.5) - 10;
  const rightColW = Math.floor(usableW * 0.5) - 10;

  // Left summary
  doc.font("Helvetica-Bold").fontSize(14).fillColor(COLORS.dark).text("Estimated Value", margins.left, y);
  y += 24;

  doc.font("Helvetica-Bold").fontSize(24).fillColor(COLORS.primary)
    .text(valuation.estimate || "$—", margins.left, y);

  y += 36;

  // Range & confidence
  doc.font("Helvetica").fontSize(10).fillColor(COLORS.muted)
    .text(
      `Range: ${valuation.range?.low || "$—"} – ${valuation.range?.high || "$—"}  •  Confidence: ${valuation.confidence || "—"}`,
      margins.left, y, { width: leftColW }
    );

  y += 20;

  // Payload facts chips
  const chips = [
    payload.year && `Year ${payload.year}`,
    payload.length && `${payload.length} ft`,
    payload.make && payload.make,
    payload.model && payload.model,
    payload.condition && payload.condition
  ].filter(Boolean);

  let cx = margins.left, cy = y;
  doc.font("Helvetica").fontSize(10);
  for (const chip of chips) {
    const { w, h } = drawChip(doc, chip, cx, cy);
    cx += w + 8;
    if (cx + 80 > margins.left + leftColW) { cx = margins.left; cy += h + 6; }
  }

  y = Math.max(cy + 30, y + 30);

  // Right summary: small comps table
  const comps = Array.isArray(valuation.comps) ? valuation.comps.slice(0, 3) : [];
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Sample Comparables", margins.left + leftColW + 20, margins.top);
  let yRight = margins.top + 20;

  comps.forEach((c) => {
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(`• ${c.title || "Comparable"}`, margins.left + leftColW + 20, yRight, { width: rightColW });
    yRight += 14;
    if (c.meta || c.price) {
      doc.fontSize(9).fillColor(COLORS.muted).text(`${c.meta || ""} ${c.price ? " • " + c.price : ""}`, margins.left + leftColW + 20, yRight, { width: rightColW });
      yRight += 12;
    }
  });

  y = Math.max(y, yRight) + 16;

  // Details section
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Boat Details", margins.left, y);
  y += 18;

  const details = [
    ["Make", payload.make || "—"],
    ["Model", payload.model || "—"],
    ["Year", payload.year || "—"],
    ["Length", payload.length ? `${payload.length} ft` : "—"],
    ["Condition", payload.condition || "—"],
    ["Engine", payload.engine || "—"],
    ["Hours", payload.hours || "—"],
    ["Trailer", payload.trailer ? "Yes" : "No"],
    ["Fuel", payload.fuel || "—"],
    ["Storage", payload.storage || "—"],
    ["Upgrades", payload.upgrades || "—"],
  ];

  const col1W = Math.floor(usableW * 0.35);
  const col2W = usableW - col1W;

  details.forEach(([k, v]) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.muted).text(k, margins.left, y, { width: col1W });
    doc.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(v, margins.left + col1W, y, { width: col2W });
    y += 16;
  });

  y += 8;

  // Rationale
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Why this estimate?", margins.left, y);
  y += 16;
  y = textBlock(
    doc,
    valuation.rationale || "Estimate considers size, age, features, general condition and current buyer demand.",
    margins.left, y, usableW, { size: 10, color: COLORS.ink }
  ) + 10;

  // Optional market trend
  if (includeTrend) {
    doc.addPage();
    header(doc, "Market Snapshot & Selling Tips");

    let y2 = margins.top;

    doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Market Snapshot", margins.left, y2);
    y2 += 16;
    y2 = textBlock(
      doc,
      "Used-boat prices have been generally steady this quarter with slightly longer time-to-sale. Expect well-presented listings with strong photos and maintenance records to command the upper range.",
      margins.left, y2, usableW, { size: 10, color: COLORS.ink }
    ) + 10;

    // comps list (expanded)
    const compsList = Array.isArray(valuation.comps) ? valuation.comps : [];
    if (compsList.length) {
      doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Comparable Listings", margins.left, y2);
      y2 += 14;
      compsList.forEach((c) => {
        doc.font("Helvetica").fontSize(10).fillColor(COLORS.ink).text(`• ${c.title || "Comparable"} — ${c.price || ""} ${c.meta ? " • " + c.meta : ""}`, margins.left, y2, { width: usableW });
        y2 += 12;
      });
      y2 += 10;
    }

    // Listing content
    doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.dark).text("Suggested Listing Copy", margins.left, y2);
    y2 += 16;
    y2 = textBlock(
      doc,
      valuation.listingTitle || `${payload.year || ""} ${payload.make || ""} ${payload.model || ""}`.trim(),
      margins.left, y2, usableW, { size: 11, color: COLORS.primary, bold: true }
    ) + 8;
    y2 = textBlock(
      doc,
      valuation.listingDescription || "Clean, well-kept boat. Priced fairly for current market. Serious buyers only.",
      margins.left, y2, usableW, { size: 10, color: COLORS.ink }
    ) + 16;

    // Prep checklist & upgrade tips columns
    const colW = Math.floor(usableW / 2) - 10;
    const cLeft = margins.left;
    const cRight = margins.left + colW + 20;

    let yLeft = textBlock(doc, "Pre-Sale Prep Checklist", cLeft, y2, colW, { size: 12, color: COLORS.dark }) + 2;
    (valuation.prepChecklist || [
      "Deep clean inside & out",
      "Service engine + fresh fluids",
      "Gather maintenance records",
      "Great photos: exterior/interior, helm, engine, trailer",
      "List upgrades & accessories clearly",
    ]).forEach((b) => {
      yLeft = textBlock(doc, `• ${b}`, cLeft, yLeft, colW, { size: 10, color: COLORS.muted });
    });

    let yRight = textBlock(doc, "Upgrade ROI Tips", cRight, y2, colW, { size: 12, color: COLORS.dark }) + 2;
    (valuation.upgradeTips || [
      "New batteries if weak",
      "Fresh bottom paint if needed",
      "Detail & oxidation removal",
      "Trailer tires & lights working",
      "Sea-trial ready: no warning lights",
    ]).forEach((b) => {
      yRight = textBlock(doc, `• ${b}`, cRight, yRight, colW, { size: 10, color: COLORS.muted });
    });
  }

  doc.end();
  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
  });
}

/* --------------------------- API handler --------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const payload = body.payload || body || {};
    const includeTrend = body.includeTrend !== false; // default true

    let valuation = normalizeValuation(body.valuation);
    if (!valuation) {
      valuation = await getValuation(payload, includeTrend);
    }

    const pdfBuffer = await buildPdf(payload, valuation, includeTrend);

    const fname = `Hullify_Valuation_${(payload.make || "Boat").replace(/\s+/g, "_").slice(0, 32)}_${payload.year || ""}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("pdf build error:", err);
    res.status(500).json({ error: "Failed to build PDF" });
  }
}
