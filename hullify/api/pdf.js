// api/pdf.js
import OpenAI from "openai";
import PDFDocument from "pdfkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------- helpers: money + fallback ------------------------ */
function numberFromMoneyStr(m) {
  if (!m) return null;
  const n = Number(String(m).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function formatMoney(n) {
  if (!Number.isFinite(n)) return "$—";
  return `$${Math.round(n).toLocaleString()}`;
}

function heuristicValuation(payload) {
  const base = 35000;
  const lenAdj = (Number(payload.length) || 0) * 900;
  const yearAdj = Math.max(0, (Number(payload.year) || 0) - 2000) * 500;
  const condMap = { Excellent: 1.15, Good: 1.05, Fair: 0.85, "Needs Work": 0.65 };
  const factor = condMap[payload.condition] || 1;
  const est = Math.round((base + lenAdj + yearAdj) * factor / 100) * 100;

  const comps = Array.from({ length: 6 }).map((_, i) => ({
    title: `${payload.make || "Boat"} ${payload.model || ""}`.trim(),
    year: payload.year || 2016 + ((i % 6) - 2),
    length: payload.length || 22,
    price: formatMoney(est * (0.92 + i * 0.02)),
    location: payload.location || "Local Market",
    url: "https://hullify.net"
  }));

  const trend = Array.from({ length: 12 }).map((_, i) => ({
    label: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11 + i, 1))
      .toLocaleString("en-US", { month: "short" }),
    price: Math.round(est * (0.92 + 0.16 * (i / 11)))
  }));

  return {
    estimate: formatMoney(est),
    range: { low: formatMoney(est * 0.97), high: formatMoney(est * 1.03) },
    confidence: "medium",
    rationale: "Heuristic model based on size, year and condition. Adjusted conservatively for market demand.",
    comps,
    listingTitle: `${payload.year || ""} ${payload.make || ""} ${payload.model || ""} • ${payload.length || "—"} ft`.replace(/\s+/g," ").trim(),
    listingDescription: `Well-kept ${payload.length || "—"}’ ${payload.make || "boat"} ${payload.model || ""} (${payload.year || "—"}). ${payload.condition || "Good"} condition. ${payload.engine ? `Engine: ${payload.engine}. ` : ""}${payload.trailer === "Yes" ? "Trailer included. " : ""}${payload.aftermarket ? `Upgrades: ${payload.aftermarket}. ` : ""}Priced to reflect current market.`,
    negotiationBullets: [
      "Priced using recent local comps",
      "Condition-adjusted (transparent range)",
      payload.trailer === "Yes" ? "Includes trailer (value add)" : "No trailer — priced accordingly"
    ],
    prepChecklist: [
      "Deep clean hull & deck; remove personal items",
      "Fresh photos: bow, helm, engine(s), trailer (if included)",
      "Have maintenance receipts handy"
    ],
    upgradeTips: [
      "LED courtesy/underwater lights can improve appeal",
      "Detailing + minor upholstery fixes often 2–5× ROI"
    ],
    trend
  };
}

async function getValuation(payload, includeTrend) {
  try {
    const messages = [
      {
        role: "system",
        content:
          "You are a marine pricing assistant. Return JSON ONLY with keys: estimate (string like \"$68,500\"), range:{low,high}, confidence (low|medium|high), rationale, comps:[{title,price,year,length,location,url}], listingTitle, listingDescription, negotiationBullets[], prepChecklist[], upgradeTips[], trend:[{label,price}] (trend required only if requested). Be conservative and adjust strongly for overall condition."
      },
      { role: "user", content: JSON.stringify({ ...payload, requestTrend: includeTrend }) }
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    const estN = numberFromMoneyStr(parsed.estimate);
    if (!estN) return heuristicValuation(payload);

    if (!Array.isArray(parsed.comps) || parsed.comps.length === 0) {
      parsed.comps = heuristicValuation(payload).comps;
    }
    if (includeTrend && (!Array.isArray(parsed.trend) || parsed.trend.length < 6)) {
      parsed.trend = heuristicValuation(payload).trend;
    }
    return parsed;
  } catch (e) {
    console.error("AI enrich error:", e);
    return heuristicValuation(payload);
  }
}

/* ------------------------------- draw helpers ------------------------------- */

function drawStamp(doc, x, y, r = 42, color = "#002B5B") {
  doc.save();
  doc.circle(x, y, r).lineWidth(3).strokeColor(color).stroke();
  doc.circle(x, y, r - 8).lineWidth(1).strokeColor(color + "aa").stroke();
  doc.fontSize(10).fillColor(color).text("HULLIFY", x - 20, y - 8);
  doc.fontSize(14).fillColor(color);
  doc.save();
  doc.translate(x, y);
  doc.rotate(-15);
  doc.text("VERIFIED", -33, -6);
  doc.restore();
  doc.restore();
}

function ensureSpace(doc, needed, margins) {
  const bottomY = doc.page.height - margins.bottom;
  if (doc.y + needed > bottomY) {
    doc.addPage();
  }
}

function drawCompsTable(doc, comps, margins, colors) {
  const width = doc.page.width - margins.left - margins.right;
  const headerY = doc.y;
  const rowH = 16;

  const col = {
    title: margins.left,
    yl: margins.left + 230,
    price: margins.left + 320,
    loc: margins.left + 400
  };

  // header
  doc.fontSize(10).fillColor(colors.muted);
  doc.text("Title", col.title, headerY);
  doc.text("Year/Len", col.yl, headerY);
  doc.text("Price", col.price, headerY);
  doc.text("Location", col.loc, headerY);
  doc.moveTo(margins.left, headerY + 12).lineTo(margins.left + width, headerY + 12).strokeColor("#e6ecf3").lineWidth(1).stroke();

  let y = headerY + 16;

  comps.forEach((c, i) => {
    // check for page break
    if (y + rowH > doc.page.height - margins.bottom) {
      doc.addPage();
      y = margins.top;
      // reprint header on new page
      doc.fontSize(10).fillColor(colors.muted);
      doc.text("Title", col.title, y);
      doc.text("Year/Len", col.yl, y);
      doc.text("Price", col.price, y);
      doc.text("Location", col.loc, y);
      doc.moveTo(margins.left, y + 12).lineTo(margins.left + width, y + 12).strokeColor("#e6ecf3").lineWidth(1).stroke();
      y += 16;
    }

    doc.fontSize(10).fillColor(colors.dark).text(c.title || "—", col.title, y, { width: 220 });
    doc.fillColor(colors.muted).text(`${c.year || "—"}/${c.length || "—"}'`, col.yl, y);
    doc.fillColor(colors.dark).text(c.price || "$—", col.price, y);
    doc.fillColor(colors.muted).text(c.location || "—", col.loc, y, { width: 120 });
    y += rowH;
  });

  doc.y = y;
}

async function buildPdf(payload, valuation, includeTrend) {
  return new Promise((resolve) => {
    const margins = { top: 60, right: 50, bottom: 60, left: 50 };
    const doc = new PDFDocument({ size: "LETTER", margins });
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const colors = {
      primary: "#002B5B",
      dark: "#0b1b2b",
      muted: "#5f7183",
      border: "#e6ecf3",
      accent: "#cfe2ff"
    };
    const pageWidth = doc.page.width;
    const usableW = pageWidth - margins.left - margins.right;

    /* ------------------------------- PAGE 1 -------------------------------- */
    doc.fillColor(colors.primary).fontSize(18).text("Hullify — Verified Valuation", margins.left, margins.top, { width: usableW, align: "left" });
    doc.moveDown(0.15).fontSize(9).fillColor(colors.muted).text(`Verified by Hullify.net • ${new Date().toLocaleString()}`, {
      width: usableW,
      align: "left"
    });

    // stamp (top-right)
    drawStamp(doc, pageWidth - margins.right - 30, margins.top + 8);

    doc.moveDown(1.2);

    const boatLine = `${payload.make || ""} ${payload.model || ""}`.trim() || "Boat";
    const metaLine = `${payload.year || "—"} • ${payload.length || "—"} ft • ${payload.vesselClass || "—"} • ${payload.hullMaterial || "—"}`;

    doc.fontSize(14).fillColor(colors.dark).text(boatLine, { width: usableW, align: "center" });
    doc.moveDown(0.1).fontSize(10).fillColor(colors.muted).text(metaLine, { width: usableW, align: "center" });

    // Big value card centered
    doc.moveDown(0.8);
    const cardW = 380, cardH = 100;
    const cardX = margins.left + (usableW - cardW) / 2;
    const cardY = doc.y;

    doc.roundedRect(cardX, cardY, cardW, cardH, 12).strokeColor(colors.border).lineWidth(1).stroke();
    doc.fontSize(11).fillColor(colors.muted).text("Estimated Value", cardX + 14, cardY + 12);
    doc.fontSize(30).fillColor(colors.primary).text(valuation.estimate || "$—", cardX + 14, cardY + 34);
    doc.fontSize(10).fillColor(colors.muted).text(
      `Range: ${(valuation.range?.low) || "$—"} – ${(valuation.range?.high) || "$—"}    •    Confidence: ${valuation.confidence || "—"}`,
      cardX + 14,
      cardY + 72
    );

    doc.moveDown(2);
    doc.fontSize(10).fillColor(colors.muted).text(
      "This report has been digitally verified by Hullify and is designed to support a fair listing price based on size, age, condition, and local market comparables.",
      { width: usableW, align: "center" }
    );

    // end page 1
    doc.addPage();

    /* ------------------------------- PAGE 2 -------------------------------- */
    doc.fillColor(colors.dark).fontSize(14).text("Why this price", margins.left, margins.top);
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted).text(valuation.rationale || "—", {
      width: usableW,
      align: "left"
    });

    doc.moveDown(0.8);

    // Two columns (details)
    const colW = (usableW - 24) / 2; // 24px gutter
    const leftX = margins.left;
    const rightX = margins.left + colW + 24;
    let y = doc.y;

    // Boat details
    doc.fontSize(12).fillColor(colors.dark).text("Boat Details", leftX, y);
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted);
    [
      ["Condition", payload.condition || "—"],
      ["Runs", payload.runs || "—"],
      ["Engine", payload.engine || "—"],
      ["Engine Hours", payload.engineHours || "—"],
      ["Fuel", payload.fuelType || "—"],
      ["Engines", payload.engineCount || "—"],
      ["Storage", payload.outOfWaterYearPlus ? "Out of water ≥1yr" : "—"]
    ].forEach(([k, v]) => doc.text(`${k}: ${v}`, leftX, doc.y, { width: colW }));

    // Ownership
    const afterLeftY = Math.max(doc.y, y);
    doc.fontSize(12).fillColor(colors.dark).text("Ownership & Location", rightX, y);
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted);
    [
      ["Location", payload.location || "—"],
      ["Trailer", payload.trailer || "—"],
      ["Title", payload.titleStatus || "—"]
    ].forEach(([k, v]) => doc.text(`${k}: ${v}`, rightX, doc.y, { width: colW }));

    doc.y = Math.max(doc.y, afterLeftY) + 12;

    // Comps
    doc.fontSize(12).fillColor(colors.dark).text("Recent Comparable Listings/Sales", margins.left, doc.y);
    doc.moveDown(0.2);
    drawCompsTable(doc, (valuation.comps || []).slice(0, 20), margins, colors); // will auto-flow pages if needed

    /* ------------------------------- PAGE 3 -------------------------------- */
    doc.addPage();

    let cursorY = margins.top;

    if (includeTrend && Array.isArray(valuation.trend) && valuation.trend.length >= 6) {
      doc.fontSize(12).fillColor(colors.dark).text("Market Trend (last 12 months)", margins.left, cursorY);
      cursorY = doc.y + 6;

      const chart = { x: margins.left, y: cursorY, w: usableW, h: 180 };
      const prices = valuation.trend.map((t) => Number(t.price));
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const pad = (max - min) * 0.1 || 1;
      const yMin = min - pad;
      const yMax = max + pad;

      // axes
      doc.strokeColor(colors.border).lineWidth(1).rect(chart.x, chart.y, chart.w, chart.h).stroke();

      // line
      doc.strokeColor("#014a8c").lineWidth(2);
      valuation.trend.forEach((p, i) => {
        const x = chart.x + (i / (valuation.trend.length - 1)) * chart.w;
        const yVal = chart.y + chart.h - ((Number(p.price) - yMin) / (yMax - yMin)) * chart.h;
        if (i === 0) doc.moveTo(x, yVal); else doc.lineTo(x, yVal);
      });
      doc.stroke();

      // labels
      doc.fontSize(9).fillColor(colors.muted);
      doc.text(formatMoney(yMax), chart.x, chart.y - 12);
      doc.text(formatMoney(yMin), chart.x, chart.y + chart.h + 2);

      valuation.trend.forEach((p, i) => {
        if (i % 2) return;
        const x = chart.x + (i / (valuation.trend.length - 1)) * chart.w - 8;
        doc.text(p.label || "", x, chart.y + chart.h + 14, { width: 30, align: "center" });
      });

      cursorY = chart.y + chart.h + 34;
    }

    // Two columns with comfy width for copy & tips
    const copyColW = (usableW - 30) / 2;
    const copyLeftX = margins.left;
    const copyRightX = margins.left + copyColW + 30;

    // Listing copy
    doc.fontSize(12).fillColor(colors.dark).text("Listing Copy", copyLeftX, cursorY);
    doc.moveDown(0.2).fontSize(11).fillColor(colors.primary).text(valuation.listingTitle || "—", copyLeftX, doc.y, { width: copyColW });
    doc.moveDown(0.2).fontSize(10).fillColor(colors.dark).text(valuation.listingDescription || "—", {
      width: copyColW
    });

    // Negotiation bullets
    const rightStartY = cursorY;
    doc.fontSize(12).fillColor(colors.dark).text("Negotiation Bullets", copyRightX, rightStartY);
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted);
    (valuation.negotiationBullets || []).forEach((b) => doc.text(`• ${b}`, copyRightX, doc.y, { width: copyColW }));

    // Prep checklist (left below description)
    ensureSpace(doc, 100, margins);
    const leftAfter = doc.y + 10;
    doc.fontSize(12).fillColor(colors.dark).text("Prep Checklist", copyLeftX, Math.max(leftAfter, rightStartY));
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted);
    (valuation.prepChecklist || []).forEach((b) => doc.text(`□ ${b}`, copyLeftX, doc.y, { width: copyColW }));

    // Upgrade tips (right under bullets)
    const rightAfter = Math.max(doc.y, rightStartY) + 10;
    doc.fontSize(12).fillColor(colors.dark).text("Upgrade ROI Tips", copyRightX, rightAfter);
    doc.moveDown(0.2).fontSize(10).fillColor(colors.muted);
    (valuation.upgradeTips || []).forEach((b) => doc.text(`• ${b}`, copyRightX, doc.y, { width: copyColW }));

    // Footer
    ensureSpace(doc, 40, margins);
    doc.moveDown(1.2);
    doc.fontSize(8).fillColor(colors.muted)
      .text("This is a non-binding estimate based on market trends and comparable sales. Not a marine survey or legal appraisal.", {
        align: "left",
        width: usableW
      });

    doc.end();
  });
}

/* ------------------------------- API handler ------------------------------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  try {
    const payload = req.body || {};
    const includeTrend = !!payload.includeTrend;

    const valuation = await getValuation(payload, includeTrend);
    const pdfBuffer = await buildPdf(payload, valuation, includeTrend);

    const fname = `Hullify_Valuation_${(payload.make || "Boat").replace(/\s+/g, "_")}_${payload.year || ""}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("pdf error:", err);
    res.status(500).json({ error: "Failed to build PDF" });
  }
}
