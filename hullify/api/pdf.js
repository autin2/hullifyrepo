// /api/pdf.js
import PDFDocument from "pdfkit";
import { computeValuation } from "./_valuation.js";

/* ----------------------------- drawing helpers ----------------------------- */
const COLORS = { primary: "#002B5B", dark: "#0b1b2b", muted: "#5f7183", border: "#e6ecf3" };

function money(n) { return `$${Math.round(n).toLocaleString()}`; }

function drawStamp(doc, cx, cy, r = 44) {
  doc.save();
  doc.circle(cx, cy, r).lineWidth(3).strokeColor(COLORS.primary).stroke();
  doc.circle(cx, cy, r - 8).lineWidth(1).strokeColor(COLORS.primary + "aa").stroke();
  doc.fontSize(10).fillColor(COLORS.primary).text("HULLIFY", cx - 20, cy - 9);
  doc.fontSize(15).fillColor(COLORS.primary); doc.translate(cx, cy).rotate(-18).text("VERIFIED", -36, -7);
  doc.restore();
}
function textBlock(doc, text, x, y, width, opts = {}) {
  const { size = 10, color = COLORS.dark, align = "left" } = opts;
  doc.fontSize(size).fillColor(color);
  const h = doc.heightOfString(String(text || ""), { width, align });
  doc.text(String(text || ""), x, y, { width, align });
  return y + h;
}
function drawComps(doc, comps, x, y, width, margins) {
  const rowH = 16; const cols = { title: x, yl: x + 230, price: x + 320, loc: x + 400 };
  doc.fontSize(10).fillColor(COLORS.muted);
  doc.text("Title", cols.title, y); doc.text("Year/Len", cols.yl, y); doc.text("Price", cols.price, y); doc.text("Location", cols.loc, y);
  doc.moveTo(x, y + 12).lineTo(x + width, y + 12).strokeColor(COLORS.border).lineWidth(1).stroke(); y += 16;
  comps.forEach((c) => {
    const bottomLimit = doc.page.height - margins.bottom;
    if (y + rowH > bottomLimit) {
      doc.addPage(); y = margins.top;
      doc.fontSize(10).fillColor(COLORS.muted);
      doc.text("Title", cols.title, y); doc.text("Year/Len", cols.yl, y); doc.text("Price", cols.price, y); doc.text("Location", cols.loc, y);
      doc.moveTo(x, y + 12).lineTo(x + width, y + 12).strokeColor(COLORS.border).lineWidth(1).stroke(); y += 16;
    }
    doc.fontSize(10).fillColor(COLORS.dark).text(c.title || "—", cols.title, y, { width: 220 });
    doc.fillColor(COLORS.muted).text(`${c.year || "—"}/${c.length || "—"}'`, cols.yl, y);
    doc.fillColor(COLORS.dark).text(c.price || "$—", cols.price, y);
    doc.fillColor(COLORS.muted).text(c.location || "—", cols.loc, y, { width: 120 });
    y += rowH;
  });
  return y;
}

/* ------------------------------- PDF builder ------------------------------- */
async function buildPdf(payload, valuation, includeTrend) {
  return new Promise((resolve) => {
    const margins = { top: 60, right: 50, bottom: 60, left: 50 };
    const doc = new PDFDocument({ size: "LETTER", margins });
    const bufs = [];
    doc.on("data", (d) => bufs.push(d));
    doc.on("end", () => resolve(Buffer.concat(bufs)));

    const pageW = doc.page.width;
    const usableW = pageW - margins.left - margins.right;

    let y = margins.top;
    doc.fontSize(18).fillColor(COLORS.primary).text("Hullify — Verified Valuation", margins.left, y);
    y += 22;
    doc.fontSize(9).fillColor(COLORS.muted).text(`Verified by Hullify.net • ${new Date().toLocaleString()}`, margins.left, y);
    drawStamp(doc, pageW - margins.right - 34, margins.top + 12);
    y += 22;

    const boatLine = `${payload.make || ""} ${payload.model || ""}`.trim() || "Boat";
    const metaLine = `${payload.year || "—"} • ${payload.length || "—"} ft • ${payload.vesselClass || "—"} • ${payload.hullMaterial || "—"}`;
    doc.fontSize(14).fillColor(COLORS.dark).text(boatLine, margins.left, y, { width: usableW, align: "center" });
    y += 18;
    doc.fontSize(10).fillColor(COLORS.muted).text(metaLine, margins.left, y, { width: usableW, align: "center" });
    y += 22;

    const cardW = 420, cardH = 110;
    const cardX = margins.left + (usableW - cardW) / 2;
    const cardY = y;
    doc.roundedRect(cardX, cardY, cardW, cardH, 12).lineWidth(1).strokeColor(COLORS.border).stroke();
    doc.fontSize(11).fillColor(COLORS.muted).text("Estimated Value (AI)", cardX + 16, cardY + 14);
    doc.fontSize(32).fillColor(COLORS.primary).text(valuation.estimate || "$—", cardX + 16, cardY + 40);
    doc.fontSize(10).fillColor(COLORS.muted).text(
      `Range: ${valuation.range?.low || "$—"} – ${valuation.range?.high || "$—"}   •   Confidence: ${valuation.confidence || "—"}`,
      cardX + 16, cardY + 78
    );

    y = cardY + cardH + 18;
    y = textBlock(doc, valuation.rationale || "AI valuation.", margins.left, y, usableW, { size: 10, color: COLORS.muted, align: "center" });
    doc.addPage();

    y = margins.top;
    y = textBlock(doc, "Why this price", margins.left, y, usableW, { size: 14, color: COLORS.dark }) + 4;
    y = textBlock(doc, valuation.rationale || "—", margins.left, y, usableW, { size: 10, color: COLORS.muted }) + 12;

    const colW = (usableW - 28) / 2; const leftX = margins.left; const rightX = margins.left + colW + 28;
    let yL = y, yR = y;

    yL = textBlock(doc, "Boat Details", leftX, yL, colW, { size: 12, color: COLORS.dark }) + 4;
    [
      ["Condition", payload.condition || "—"],
      ["Runs", payload.runs || "—"],
      ["Engine", payload.engine || "—"],
      ["Engine Hours", payload.engineHours || "—"],
      ["Fuel", payload.fuelType || "—"],
      ["Engines", payload.engineCount || "—"],
      ["Storage", payload.outOfWaterYearPlus ? "Out of water ≥1yr" : "—"],
    ].forEach(([k, v]) => { yL = textBlock(doc, `${k}: ${v}`, leftX, yL, colW, { size: 10, color: COLORS.muted }); });

    yR = textBlock(doc, "Ownership & Location", rightX, yR, colW, { size: 12, color: COLORS.dark }) + 4;
    [
      ["Location", payload.location || "—"],
      ["Trailer", payload.trailer || "—"],
      ["Title", payload.titleStatus || "—"],
    ].forEach(([k, v]) => { yR = textBlock(doc, `${k}: ${v}`, rightX, yR, colW, { size: 10, color: COLORS.muted }); });

    y = Math.max(yL, yR) + 14;

    y = textBlock(doc, "Recent Comparable Listings/Sales", margins.left, y, usableW, { size: 12, color: COLORS.dark }) + 4;
    doc.y = y;
    y = drawComps(doc, (valuation.comps || []).slice(0, 30), margins.left, doc.y, usableW, margins);

    doc.addPage();
    y = margins.top;

    if (Array.isArray(valuation.trend) && valuation.trend.length >= 6) {
      y = textBlock(doc, "Market Trend (last 12 months)", margins.left, y, usableW, { size: 12, color: COLORS.dark }) + 6;
      const chart = { x: margins.left, y, w: usableW, h: 190 };
      const prices = valuation.trend.map((t) => Number(t.price));
      const min = Math.min(...prices), max = Math.max(...prices);
      const pad = (max - min) * 0.1 || 1, yMin = min - pad, yMax = max + pad;
      doc.strokeColor(COLORS.border).lineWidth(1).rect(chart.x, chart.y, chart.w, chart.h).stroke();
      doc.strokeColor("#014a8c").lineWidth(2);
      valuation.trend.forEach((p,i)=>{ const x = chart.x + (i/(valuation.trend.length-1))*chart.w; const yVal = chart.y + chart.h - ((Number(p.price)-yMin)/(yMax-yMin))*chart.h; if(i===0) doc.moveTo(x,yVal); else doc.lineTo(x,yVal); });
      doc.stroke();
      doc.fontSize(9).fillColor(COLORS.muted);
      doc.text(money(yMax), chart.x, chart.y - 12);
      doc.text(money(yMin), chart.x, chart.y + chart.h + 2);
      valuation.trend.forEach((p,i)=>{ if(i%2) return; const lx = chart.x + (i/(valuation.trend.length-1))*chart.w - 8; doc.text(p.label || "", lx, chart.y + chart.h + 14, { width: 30, align: "center" }); });
      y = chart.y + chart.h + 36;
    }

    const copyColW = (usableW - 34) / 2; const cLeft = margins.left; const cRight = margins.left + copyColW + 34;
    let yLeft = y, yRight = y;

    yLeft = textBlock(doc, "Listing Copy", cLeft, yLeft, copyColW, { size: 12, color: COLORS.dark }) + 2;
    yLeft = textBlock(doc, valuation.listingTitle || "—", cLeft, yLeft, copyColW, { size: 11, color: COLORS.primary }) + 2;
    yLeft = textBlock(doc, valuation.listingDescription || "—", cLeft, yLeft, copyColW, { size: 10, color: COLORS.dark });

    yRight = textBlock(doc, "Negotiation Bullets", cRight, yRight, copyColW, { size: 12, color: COLORS.dark }) + 2;
    (valuation.negotiationBullets || []).forEach((b)=>{ yRight = textBlock(doc, `• ${b}`, cRight, yRight, copyColW, { size: 10, color: COLORS.muted }); });

    y = Math.max(yLeft, yRight) + 12;
    yLeft = textBlock(doc, "Prep Checklist", cLeft, y, copyColW, { size: 12, color: COLORS.dark }) + 2;
    (valuation.prepChecklist || []).forEach((b)=>{ yLeft = textBlock(doc, `□ ${b}`, cLeft, yLeft, copyColW, { size: 10, color: COLORS.muted }); });

    yRight = textBlock(doc, "Upgrade ROI Tips", cRight, y, copyColW, { size: 12, color: COLORS.dark }) + 2;
    (valuation.upgradeTips || []).forEach((b)=>{ yRight = textBlock(doc, `• ${b}`, cRight, yRight, copyColW, { size: 10, color: COLORS.muted }); });

    y = Math.max(yLeft, yRight) + 16;
    textBlock(doc, "This is a non-binding estimate based on AI valuation and comparable sales. Not a marine survey or legal appraisal.", margins.left, y, usableW, { size: 8, color: COLORS.muted });

    doc.end();
  });
}

/* --------------------------------- API -------------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST" });
  }

  const payload = await readJsonBody(req);

  try {
    const includeTrend = payload.includeTrend !== false;
    const valuation = await computeValuation(payload, { includeTrend });
    const pdfBuffer = await buildPdf(payload, valuation, includeTrend);

    const fname = `Hullify_Valuation_${(payload.make || "Boat").replace(/\s+/g, "_").slice(0, 32)}_${payload.year || ""}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).end(pdfBuffer);
  } catch (err) {
    console.error("pdf build error:", err);
    return res.status(500).json({ error: "Failed to build PDF" });
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
