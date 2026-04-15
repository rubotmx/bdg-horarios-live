// Proxy Shopify Admin API — evita CORS desde el browser
import { shopifyFetch, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const title = req.query.title || "";
  if (!title) return res.status(400).json({ error: "title requerido" });

  try {
    const url = `https://${STORE}/admin/api/2024-01/products.json`
      + `?title=${encodeURIComponent(title)}&fields=id,title,variants,images&limit=10`;
    const r = await shopifyFetch(url);
    if (!r.ok) return res.status(r.status).json({ error: `Shopify ${r.status}` });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
