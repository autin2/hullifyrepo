// api/pdf.js
import OpenAI from "openai";
import PDFDocument from "pdfkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Helpers ----------------------------------------------------

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
    url: "https://example.com"
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
    rationale: "Heuristic model based on size, year, and condition.",
    comps,
    listingTitle: `${payload.year || ""} ${payload.make || ""} ${payload.model || ""} • ${payload.length || "—"} ft • ${payload.engine || "Clean power"}`
      .replace(/\s+/g, " ")
      .trim(),
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
          "You are a marine pricing assistant. Return JSON ONLY with keys: estimate (string like \"$68,500\"), range:{low,high}, confidence (low|medium|high), rationale, comps:[{title,price,year,length,location,url}], listingTitle, listingDescription, negotiationBullets[], prepChecklist[], upgradeTips[], trend:[{label,price}] (trend array required only if requested). Be conservative and adjust strongly for overall condition."
      },
      {
        role: "user",
        content: JSON.stringify({
          ...payload,
          requestTrend: includeTrend
        })
      }
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    // Minimal normalization + fallback fill-ins
    const estN = numberFromMoneyStr(parsed.estimate);
    if (!estN) return heuristicValuation(payload);

    if (includeTrend && (!Array.isArray(parsed.trend) || parsed.trend.length < 6)) {
      parsed.trend = heuristicValuation(payload).trend;
    }
    if (!Array.isArray(parsed.comps) || parsed.comps.length === 0) {
      parsed.comps = heuristicValuation(payload).comps;
    }
    return parsed;
  } catch (e) {
    console.error("AI enrich error:", e);
    return heuristicValuation(payload);
  }
}

// Build the PDF and return a Buffer
async function buildPdf(payload, valuation, includeTrend) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    const chunks = [];
    doc.on("data", (d) => chunks.push(d));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const primary = "#002B5B";
    const muted = "#5f7183";

    // Header
    doc
      .fillColor(primary)
      .fontSize(20)
      .text("Hullify — Sell-Ready Valuation", { align: "left" })
      .moveDown(0.2)
      .fontSize(10)
      .fillColor(muted)
      .text(new Date().toLocaleString(), { align: "left" })
      .moveDown();

    // Boat line
    const boatLine = `${payload.make || ""} ${payload.model || ""}`.trim();
    const metaLine = `${payload.year || "—"} • ${payload.length || "—"} ft • ${payload.vesselClass || "—"} • ${payload.hullMaterial || "—"}`;
    doc
      .fontSize(14)
      .fillColor("#0b1b2b")
      .text(boatLine || "Boat", { continued: false })
      .fontSize(11)
      .fillColor(muted)
      .text(metaLine)
      .moveDown(0.6);

    // Summary card
    const yStart = doc.y;
    doc.roundedRect(50, yStart, 512, 90, 10).strokeColor("#e6ecf3").lineWidth(1).stroke();
    doc
      .fontSize(12)
      .fillColor(muted)
      .text("Estimated Value", 60, yStart + 10);
    doc
      .fontSize(24)
      .fillColor(primary)
      .text(valuation.estimate || "$—", 60, yStart + 28);
    doc
      .fontSize(10)
      .fillColor(muted)
      .text(
        `Range: ${(valuation.range?.low) || "$—"} – ${(valuation.range?.high) || "$—"}    •    Confidence: ${valuation.confidence || "—"}`,
        60,
        yStart + 60
      );
    doc.moveDown(2);

    // Why
    doc
      .fontSize(12)
      .fillColor("#0b1b2b")
      .text("Why this price", { underline: false })
      .moveDown(0.2)
      .fontSize(10)
      .fillColor(muted)
      .text(valuation.rationale || "—", { align: "left" })
      .moveDown();

    // Details columns
    const leftX = 50;
    const rightX = 320;
    const startY = doc.y;

    doc.fontSize(12).fillColor("#0b1b2b").text("Boat Details", leftX, startY);
    doc.fontSize(10).fillColor(muted);
    const details = [
      ["Condition", payload.condition || "—"],
      ["Runs", payload.runs || "—"],
      ["Engine", payload.engine || "—"],
      ["Engine Hours", payload.engineHours || "—"],
      ["Fuel", payload.fuelType || "—"],
      ["Engines", payload.engineCount || "—"],
      ["Storage", payload.outOfWaterYearPlus ? "Out of water ≥1yr" : "—"]
    ];
    details.forEach(([k, v]) => doc.text(`${k}: ${v}`));
    doc.moveDown();

    doc.fontSize(12).fillColor("#0b1b2b").text("Ownership & Location", rightX, startY);
    doc.fontSize(10).fillColor(muted);
    const detailsR = [
      ["Location", payload.location || "—"],
      ["Trailer", payload.trailer || "—"],
      ["Title", payload.titleStatus || "—"]
    ];
    detailsR.forEach(([k, v]) => doc.text(`${k}: ${v}`, rightX));
    doc.moveDown(1.2);

    // Comps table
    doc.fontSize(12).fillColor("#0b1b2b").text("Recent Comparable Listings/Sales");
    doc.moveDown(0.3);
    const comps = (valuation.comps || []).slice(0, 6);
    doc.fontSize(10).fillColor(muted);
    const colX = [50, 280, 360, 430];
    doc.text("Title", colX[0], doc.y);
    doc.text("Year/Len", colX[1], doc.y);
    doc.text("Price", colX[2], doc.y);
    doc.text("Location", colX[3], doc.y);
    doc
      .moveTo(50, doc.y + 2)
      .lineTo(562, doc.y + 2)
      .strokeColor("#e6ecf3")
      .lineWidth(1)
      .stroke();

    comps.forEach((c) => {
      doc.moveDown(0.3);
      doc.fillColor("#0b1b2b").text(c.title || "—", colX[0], doc.y, { width: 210 });
      doc.fillColor(muted).text(`${c.year || "—"}/${c.length || "—"}'`, colX[1], doc.y);
      doc.fillColor("#0b1b2b").text(c.price || "$—", colX[2], doc.y);
      doc.fillColor(muted).text(c.location || "—", colX[3], doc.y, { width: 130 });
    });

    // Trend chart
    if (includeTrend && Array.isArray(valuation.trend) && valuation.trend.length >= 6) {
      doc.addPage();
      doc.fontSize(12).fillColor("#0b1b2b").text("Market Trend (last 12 months)");
      const chart = { x: 70, y: doc.y + 10, w: 472, h: 180 };
      const prices = valuation.trend.map((t) => Number(t.price));
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const pad = (max - min) * 0.1 || 1;
      const yMin = min - pad;
      const yMax = max + pad;

      // axes
      doc.strokeColor("#e6ecf3").lineWidth(1).rect(chart.x, chart.y, chart.w, chart.h).stroke();

      // line
      doc.strokeColor("#014a8c").lineWidth(2);
      valuation.trend.forEach((p, i) => {
        const x = chart.x + (i / (valuation.trend.length - 1)) * chart.w;
        const y = chart.y + chart.h - ((Number(p.price) - yMin) / (yMax - yMin)) * chart.h;
        if (i === 0) doc.moveTo(x, y);
        else doc.lineTo(x, y);
      });
      doc.stroke();

      // min/max labels
      doc.fontSize(9).fillColor(muted);
      doc.text(formatMoney(yMax), chart.x, chart.y - 12);
      doc.text(formatMoney(yMin), chart.x, chart.y + chart.h + 2);

      // month labels (every 2nd)
      valuation.trend.forEach((p, i) => {
        if (i % 2) return;
        const x = chart.x + (i / (valuation.trend.length - 1)) * chart.w - 8;
        doc.text(p.label || "", x, chart.y + chart.h + 14, { width: 30, align: "center" });
      });
      doc.moveDown(3);
    }

    // Listing copy
    doc.fontSize(12).fillColor("#0b1b2b").text("Listing Copy");
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor(primary).text(valuation.listingTitle || "—");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#0b1b2b").text(valuation.listingDescription || "—");
    doc.moveDown(0.8);

    // Negotiation bullets
    doc.fontSize(12).fillColor("#0b1b2b").text("Negotiation Bullets");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor(muted);
    (valuation.negotiationBullets || []).forEach((b) => doc.text(`• ${b}`));
    doc.moveDown(0.8);

    // Prep checklist
    doc.fontSize(12).fillColor("#0b1b2b").text("Prep Checklist");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor(muted);
    (valuation.prepChecklist || []).forEach((b) => doc.text(`□ ${b}`));
    doc.moveDown(0.8);

    // Upgrades / ROI
    doc.fontSize(12).fillColor("#0b1b2b").text("Upgrade ROI Tips");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor(muted);
    (valuation.upgradeTips || []).forEach((b) => doc.text(`• ${b}`));

    // Footer
    doc.moveDown(1.2);
    doc
      .fontSize(8)
      .fillColor(muted)
      .text("This is a non-binding estimate based on market trends and comparable sales. This is not a marine survey or a legal appraisal.", { align: "left" });

    doc.end();
  });
}

// ---- API handler ------------------------------------------------

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

    const fname = `Hullify_Valuation_${(payload.make || "Boat")
      .replace(/\s+/g, "_")}_${payload.year || ""}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("pdf error:", err);
    res.status(500).json({ error: "Failed to build PDF" });
  }
}
