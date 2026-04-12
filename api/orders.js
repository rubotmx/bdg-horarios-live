// Proxy Shopify — pedidos TikTok pagados en un rango de fechas
const STORE = "baladigalamx.myshopify.com";
const TOKEN = process.env.SHOPIFY_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { date_min, date_max } = req.query;
  if (!date_min || !date_max) return res.status(400).json({ error: "date_min y date_max requeridos" });

  try {
    const orders = [];
    let url = `https://${STORE}/admin/api/2024-01/orders.json`
      + `?status=any&financial_status=paid&source_name=tiktok`
      + `&created_at_min=${date_min}&created_at_max=${date_max}`
      + `&limit=250&fields=id,created_at,total_price`;

    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
      if (!r.ok) return res.status(r.status).json({ error: `Shopify ${r.status}` });
      const data = await r.json();
      const batch = (data.orders || []).filter(o => parseFloat(o.total_price) > 0);
      orders.push(...batch);

      // Paginación via Link header
      const link = r.headers.get("Link") || "";
      url = null;
      for (const part of link.split(",")) {
        if (part.includes('rel="next"')) {
          url = part.split(";")[0].trim().replace(/[<>]/g, "");
        }
      }
    }

    return res.status(200).json({ orders });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
