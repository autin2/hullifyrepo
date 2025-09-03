// /api/checkout.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

function getOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { plan } = req.query || {};
    const origin = getOrigin(req);

    const priceMap = {
      reveal_199: { name: "Reveal Estimate (on-page)",         unit_amount: 199  }, // $1.99
      pdf_1900:   { name: "Sell-Ready PDF (with Trend Chart)", unit_amount: 999  }, // $9.99  ⬅️ fixed comment
    };

    const price = priceMap[plan];
    if (!price) return res.status(400).json({ error: "Invalid plan" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: price.name },
          unit_amount: price.unit_amount,
        },
        quantity: 1,
      }],
      client_reference_id: plan,
      success_url: `${origin}/estimate.html?success=1&plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/estimate.html?canceled=1`,
    });

    res.writeHead(303, { Location: session.url }).end();
  } catch (err) {
    console.error("checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
}
