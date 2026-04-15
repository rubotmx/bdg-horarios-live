// Proxy Shopify — pedidos TikTok pagados en un rango de fechas
import { paginateAll, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { date_min, date_max } = req.query;
  if (!date_min || !date_max) return res.status(400).json({ error: "date_min y date_max requeridos" });

  try {
    const startUrl = `https://${STORE}/admin/api/2024-01/orders.json`
      + `?status=any&financial_status=paid&source_name=tiktok`
      + `&created_at_min=${date_min}&created_at_max=${date_max}`
      + `&limit=250&fields=id,created_at,total_price`;

    const allOrders = await paginateAll(startUrl, "orders");
    const orders = allOrders.filter(o => parseFloat(o.total_price) > 0);
    return res.status(200).json({ orders });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
