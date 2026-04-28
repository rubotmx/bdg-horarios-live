// /api/shopify-archive — Marca productos como "archived" en Shopify
//
// Uso:
//   POST /api/shopify-archive
//   Body: { product_ids: [12345, 67890, ...] }
//
// Esto hace que dejen de aparecer en el catálogo activo de Shopify, pero
// NO los borra (se pueden restaurar). Es la limpieza recomendada para los
// SKUs marcados como "discontinued" en el sistema de restock.
//
// IMPORTANTE: Solo admins (verificación en frontend, ya que la auth de
// Shopify se maneja con SHOPIFY_TOKEN del backend).

import { shopifyFetch, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const ids = Array.isArray(body.product_ids) ? body.product_ids : [];

  if (ids.length === 0) {
    return res.status(400).json({ error: "product_ids[] requerido (no vacío)" });
  }
  if (ids.length > 200) {
    return res.status(400).json({ error: "Máximo 200 productos por llamada (rate limit)" });
  }

  const results = [];
  let succeeded = 0, failed = 0;

  for (const id of ids) {
    try {
      const r = await shopifyFetch(`/products/${id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: { id, status: "archived" } }),
      });
      if (r.ok) {
        succeeded++;
        results.push({ id, ok: true });
      } else {
        failed++;
        const errBody = await r.text();
        results.push({ id, ok: false, error: `${r.status}: ${errBody.slice(0, 200)}` });
      }
      // Rate limit suave: 2 req/seg para no saturar
      await new Promise(resolve => setTimeout(resolve, 600));
    } catch (e) {
      failed++;
      results.push({ id, ok: false, error: e.message });
    }
  }

  return res.status(200).json({ ok: failed === 0, succeeded, failed, results });
}
