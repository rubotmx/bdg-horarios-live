// /api/images — Devuelve mapa de título de producto → imagen (caché 30min)
import { shopifyFetch, nextPageUrl, setCors } from "./_shopify.js";

let _cache = null;
let _expiry = 0;
const TTL = 30 * 60 * 1000;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (_cache && Date.now() < _expiry) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(_cache);
  }

  try {
    const images = {};
    let url = `https://baladigalamx.myshopify.com/admin/api/2024-01/products.json?limit=250&fields=title,images`;
    while (url) {
      const r = await shopifyFetch(url);
      if (!r.ok) break;
      const data = await r.json();
      for (const p of (data.products || [])) {
        if (p.images?.[0]?.src) images[p.title] = p.images[0].src;
      }
      url = nextPageUrl(r.headers.get("Link") || "");
    }
    _cache  = images;
    _expiry = Date.now() + TTL;
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(images);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
