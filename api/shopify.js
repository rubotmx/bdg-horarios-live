// Proxy Shopify Admin API — todos los canales, con resumen agregado
import { shopifyFetch, paginateAll, nextPageUrl, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

const _cache = new Map();
const CACHE_TTL         = 5  * 60 * 1000; // 5 min
const CACHE_TTL_CATALOG = 30 * 60 * 1000; // 30 min

function getCached(key) {
  const e = _cache.get(key);
  return e && Date.now() < e.expiry ? e.data : null;
}
function setCache(key, data, ttl = CACHE_TTL) {
  _cache.set(key, { data, expiry: Date.now() + ttl });
}

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { date_min, date_max, mode = "orders" } = req.query;

  if (mode === "products") return handleProducts(req, res);

  if (!date_min || !date_max) return res.status(400).json({ error: "date_min y date_max requeridos" });

  const cacheKey = `${mode}_${date_min}_${date_max}`;
  const hit = getCached(cacheKey);
  if (hit) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(hit); }

  try {
    const startUrl = `https://${STORE}/admin/api/2024-01/orders.json`
      + `?status=any&financial_status=paid`
      + `&created_at_min=${date_min}&created_at_max=${date_max}`
      + `&limit=250&fields=id,created_at,total_price,subtotal_price,source_name,`
      + `financial_status,fulfillment_status,line_items,discount_codes,total_discounts`;

    const orders = await paginateAll(startUrl, "orders");
    const filtered = orders.filter(o => parseFloat(o.total_price) > 0);

    const bySource = {}, byDay = {}, byProduct = {};

    for (const o of filtered) {
      const src   = o.source_name || "web";
      const day   = o.created_at.slice(0, 10);
      const price = parseFloat(o.total_price);

      if (!bySource[src]) bySource[src] = { orders: 0, gmv: 0 };
      bySource[src].orders++;
      bySource[src].gmv += price;

      if (!byDay[day]) byDay[day] = { orders: 0, gmv: 0 };
      byDay[day].orders++;
      byDay[day].gmv += price;

      for (const item of (o.line_items || [])) {
        const title = item.title;
        if (!byProduct[title]) byProduct[title] = { units: 0, gmv: 0 };
        byProduct[title].units += item.quantity;
        byProduct[title].gmv  += parseFloat(item.price) * item.quantity;
      }
    }

    const totalGMV    = filtered.reduce((s, o) => s + parseFloat(o.total_price), 0);
    const totalOrders = filtered.length;

    const result = {
      summary: {
        total_orders: totalOrders,
        total_gmv:    Math.round(totalGMV * 100) / 100,
        aov:          totalOrders > 0 ? Math.round(totalGMV / totalOrders * 100) / 100 : 0,
      },
      by_source:    bySource,
      by_day:       byDay,
      top_products: Object.entries(byProduct)
        .map(([title, v]) => ({ title, ...v }))
        .sort((a, b) => b.gmv - a.gmv)
        .slice(0, 10),
    };
    setCache(cacheKey, result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleProducts(req, res) {
  const cacheKey = "catalog_enriched_v2";
  const hit = getCached(cacheKey);
  if (hit) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(hit); }

  try {
    // 1. Todos los productos
    const products = await paginateAll(
      `https://${STORE}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,images,product_type,status,created_at`,
      "products"
    );

    // 2. Órdenes históricas en chunks trimestrales (paralelos)
    const START_YEAR = 2020;
    const now = new Date();
    const chunks = [];
    let cursor = new Date(START_YEAR, 0, 1);
    while (cursor < now) {
      const start = new Date(cursor);
      cursor.setMonth(cursor.getMonth() + 3);
      const end = cursor < now ? new Date(cursor) : new Date(now);
      chunks.push({ min: start.toISOString(), max: end.toISOString() });
    }

    const BASE = `https://${STORE}/admin/api/2024-01/orders.json`
      + `?status=any&financial_status=paid&limit=250&fields=line_items`;

    const chunkOrders = await Promise.all(
      chunks.map(({ min, max }) =>
        paginateAll(`${BASE}&created_at_min=${min}&created_at_max=${max}`, "orders")
      )
    );

    const unitsByProduct = {};
    for (const orders of chunkOrders) {
      for (const order of orders) {
        for (const item of (order.line_items || [])) {
          if (item.product_id) {
            unitsByProduct[item.product_id] = (unitsByProduct[item.product_id] || 0) + item.quantity;
          }
        }
      }
    }

    for (const p of products) {
      p.units_sold = unitsByProduct[p.id] || 0;
    }

    const result = { products, sales_period: "2020+" };
    setCache(cacheKey, result, CACHE_TTL_CATALOG);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
