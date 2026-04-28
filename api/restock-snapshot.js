// /api/restock-snapshot — corazón del sistema de reorder point automático
//
// Combina:
//   1. Inventario actual de todos los variants en Shopify
//   2. Ventas históricas (últimos 90 días, todos los canales)
//
// Para cada variant calcula:
//   - velocity_per_day (weighted: 50% últimos 7d, 30% 30d, 20% 90d)
//   - reorder_point   = velocity × lead_time + safety_stock
//   - target_stock    = velocity × (lead_time + days_of_supply)
//   - suggested_order = max(0, target_stock − stock_current)
//   - days_until_stockout = stock_current / velocity
//   - status (ok | warn | alert | critical | out)
//
// Query params (todos opcionales):
//   ?lead_time_days=14
//   ?safety_days=7
//   ?target_days=30
//   ?lookback_days=90

import { shopifyFetch, paginateAll, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

// ── Cache en memoria del lambda (10 min) ──────────────────────────────────────
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Parámetros configurables
  const leadTime  = parseInt(req.query.lead_time_days)  || 14;
  const safety    = parseInt(req.query.safety_days)     || 7;
  const target    = parseInt(req.query.target_days)     || 30;
  const lookback  = parseInt(req.query.lookback_days)   || 90;
  const force     = req.query.force === "1";

  const cacheKey = `${leadTime}|${safety}|${target}|${lookback}`;

  // Cache hit
  if (!force && _cache && _cache.key === cacheKey && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return res.status(200).json({ ..._cache.data, _cache: "HIT" });
  }

  try {
    const t0 = Date.now();

    // ── 1. Pull all variants (stock + metadata) ──────────────────────────────
    const products = await fetchAllProducts();
    const t1 = Date.now();

    // Build variant map: variant_id → { ...info, stock }
    const variants = {};
    for (const p of products) {
      const imageUrl = p.images?.[0]?.src || p.image?.src || null;
      for (const v of (p.variants || [])) {
        // Detectar talla: option1/option2/option3 — buscamos el que sea numérico (23-30)
        const opts  = [v.option1, v.option2, v.option3].filter(Boolean);
        const sizeOpt = opts.find(o => /^\d{2}(\.\d)?$/.test(String(o).trim()));
        variants[v.id] = {
          variant_id:    v.id,
          product_id:    p.id,
          product_title: p.title,
          sku:           v.sku || "",
          size:          sizeOpt || opts[0] || "",
          image:         imageUrl,
          price:         parseFloat(v.price || "0"),
          stock_current: typeof v.inventory_quantity === "number" ? v.inventory_quantity : 0,
          sales_7d:      0,
          sales_30d:     0,
          sales_90d:     0,
        };
      }
    }

    // ── 2. Pull ventas históricas (últimos `lookback` días) ───────────────────
    const now      = new Date();
    const dateMin  = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000).toISOString();
    const dateMax  = now.toISOString();
    const orders   = await fetchAllOrdersWithLineItems(dateMin, dateMax);
    const t2 = Date.now();

    // Acumular ventas por variant_id en buckets de tiempo
    const ms7  = 7  * 24 * 60 * 60 * 1000;
    const ms30 = 30 * 24 * 60 * 60 * 1000;
    const nowMs = now.getTime();

    for (const order of orders) {
      const orderTime = new Date(order.created_at).getTime();
      const ageMs = nowMs - orderTime;
      for (const li of (order.line_items || [])) {
        const vid = li.variant_id;
        if (!vid || !variants[vid]) continue;
        const qty = li.quantity || 0;
        variants[vid].sales_90d += qty;
        if (ageMs <= ms30) variants[vid].sales_30d += qty;
        if (ageMs <= ms7)  variants[vid].sales_7d  += qty;
      }
    }

    // ── 3. Calcular velocity, RP, sugerencia, status ─────────────────────────
    const skus = Object.values(variants).map(v => {
      // Velocidad por día — weighted average
      const vel7  = v.sales_7d  / 7;
      const vel30 = v.sales_30d / 30;
      const vel90 = v.sales_90d / 90;
      // Si tiene 7d ventas, peso fuerte en reciente; si no, suaviza con histórico
      const velocity_per_day = vel7 > 0
        ? (vel7 * 0.5 + vel30 * 0.3 + vel90 * 0.2)
        : (vel30 * 0.6 + vel90 * 0.4);

      const safety_stock    = velocity_per_day * safety;
      const reorder_point   = velocity_per_day * leadTime + safety_stock;
      const target_stock    = velocity_per_day * (leadTime + target);
      const days_until_stockout = velocity_per_day > 0 ? v.stock_current / velocity_per_day : 999;

      // Si no hay rotación, no tiene sentido sugerir reorden
      const suggested_order = velocity_per_day > 0
        ? Math.max(0, Math.ceil(target_stock - v.stock_current))
        : 0;

      // Status semáforo — separado por si tiene rotación o no
      let status;
      if (velocity_per_day === 0) {
        // Sin rotación reciente
        if (v.stock_current > 0)  status = "dead";          // 💀 inventario inmóvil
        else                       status = "discontinued"; // ⚫ probablemente descontinuado
      } else {
        // Con rotación → aplicar lógica de reorder
        if (v.stock_current <= 0)                          status = "out";       // 🔴 sin stock pero sí vende
        else if (days_until_stockout < leadTime)           status = "critical";  // 🔴 va a romper antes de llegar OC
        else if (v.stock_current < reorder_point)          status = "alert";     // 🟠 cruzó reorder point
        else if (v.stock_current < reorder_point * 1.25)   status = "warn";      // 🟡 cerca del reorder
        else                                                status = "ok";       // 🟢
      }

      return {
        ...v,
        velocity_per_day:      Math.round(velocity_per_day * 100) / 100,
        reorder_point:         Math.round(reorder_point),
        target_stock:          Math.round(target_stock),
        suggested_order,
        days_until_stockout:   Math.round(days_until_stockout * 10) / 10,
        status,
      };
    });

    const t3 = Date.now();

    const data = {
      computed_at: new Date().toISOString(),
      params: { lead_time_days: leadTime, safety_days: safety, target_days: target, lookback_days: lookback },
      counts: { variants: skus.length, orders_used: orders.length, products: products.length },
      timing_ms: { products: t1 - t0, orders: t2 - t1, compute: t3 - t2, total: t3 - t0 },
      skus,
    };

    _cache   = { key: cacheKey, data };
    _cacheAt = Date.now();

    return res.status(200).json({ ...data, _cache: "MISS" });
  } catch (e) {
    console.error("[restock-snapshot] error:", e);
    return res.status(500).json({ error: e.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function fetchAllProducts() {
  const startUrl = `https://${STORE}/admin/api/2024-01/products.json`
    + `?limit=250&fields=id,title,images,image,variants`;
  return paginateAll(startUrl, "products");
}

async function fetchAllOrdersWithLineItems(dateMin, dateMax) {
  // Trae TODAS las órdenes pagadas (no solo TikTok)
  const startUrl = `https://${STORE}/admin/api/2024-01/orders.json`
    + `?status=any&financial_status=paid`
    + `&created_at_min=${encodeURIComponent(dateMin)}&created_at_max=${encodeURIComponent(dateMax)}`
    + `&limit=250&fields=id,created_at,line_items`;
  return paginateAll(startUrl, "orders");
}
