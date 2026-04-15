// ── Shared Shopify helper ─────────────────────────────────────────────────────
// Centraliza la lógica de paginación (Link header) para todos los endpoints API.
// Uso: import { shopifyFetch, paginateAll } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";
const TOKEN = process.env.SHOPIFY_TOKEN;

/** Hace un fetch autenticado a la Admin API de Shopify */
export async function shopifyFetch(path, opts = {}) {
  const url = path.startsWith("http") ? path : `https://${STORE}/admin/api/2024-01${path}`;
  return fetch(url, {
    ...opts,
    headers: { "X-Shopify-Access-Token": TOKEN, ...(opts.headers || {}) },
  });
}

/** Recorre todas las páginas de una URL de Shopify usando el Link header */
export async function paginateAll(startUrl, dataKey = "orders") {
  const results = [];
  let url = startUrl;
  while (url) {
    const r = await shopifyFetch(url);
    if (!r.ok) break;
    const data = await r.json();
    results.push(...(data[dataKey] || []));
    const link = r.headers.get("Link") || "";
    url = null;
    for (const part of link.split(",")) {
      if (part.includes('rel="next"')) {
        url = part.split(";")[0].trim().replace(/[<>]/g, "");
      }
    }
  }
  return results;
}

/** Parsea el Link header de Shopify y retorna la URL de la siguiente página */
export function nextPageUrl(linkHeader = "") {
  for (const part of linkHeader.split(",")) {
    if (part.includes('rel="next"')) return part.split(";")[0].trim().replace(/[<>]/g, "");
  }
  return null;
}

/** CORS headers — restringe al dominio propio */
export function setCors(res, req) {
  const origin = req.headers.origin || "";
  const allowed = ["https://bdghq.com", "https://www.bdghq.com"];
  // Permite también localhost en desarrollo
  const isDev = origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
  const allowedOrigin = allowed.includes(origin) || isDev ? origin : "https://bdghq.com";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}
