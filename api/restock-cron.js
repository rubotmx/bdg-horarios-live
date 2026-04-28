// /api/restock-cron — Precalcula el snapshot de restock cada mañana
// Cron diario a las 5am MX (11:00 UTC) configurado en vercel.json
// El resultado se guarda en Firebase /restock_snapshot/current para que
// la UI lo lea instantáneamente.

import { shopifyFetch, paginateAll, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";
const FB_URL = "https://bdg-horarios-default-rtdb.firebaseio.com/restock_snapshot/current.json";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Auth: solo Vercel Cron o llamada manual con Bearer token
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Parámetros default — los mismos que usa la UI por default
  const leadTime = 14, safety = 7, target = 30, lookback = 90;

  try {
    const t0 = Date.now();

    // 1. Pull products
    const products = await fetchAllProducts();
    const t1 = Date.now();

    // Build variant map
    const variants = {};
    for (const p of products) {
      const imageUrl = p.images?.[0]?.src || p.image?.src || null;
      for (const v of (p.variants || [])) {
        const opts = [v.option1, v.option2, v.option3].filter(Boolean);
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
          sales_7d: 0, sales_30d: 0, sales_90d: 0,
        };
      }
    }

    // 2. Pull orders
    const now = new Date();
    const dateMin = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000).toISOString();
    const dateMax = now.toISOString();
    const orders = await fetchAllOrdersWithLineItems(dateMin, dateMax);
    const t2 = Date.now();

    const ms7  = 7  * 24 * 60 * 60 * 1000;
    const ms30 = 30 * 24 * 60 * 60 * 1000;
    const nowMs = now.getTime();

    for (const order of orders) {
      const ageMs = nowMs - new Date(order.created_at).getTime();
      for (const li of (order.line_items || [])) {
        const vid = li.variant_id;
        if (!vid || !variants[vid]) continue;
        const qty = li.quantity || 0;
        variants[vid].sales_90d += qty;
        if (ageMs <= ms30) variants[vid].sales_30d += qty;
        if (ageMs <= ms7)  variants[vid].sales_7d  += qty;
      }
    }

    // 3. Pull OCs en tránsito desde Firebase
    let inTransit = {};
    try {
      const fbPos = await fetch("https://bdg-horarios-default-rtdb.firebaseio.com/restock_pos.json");
      if (fbPos.ok) {
        const pos = (await fbPos.json()) || {};
        Object.values(pos).forEach(po => {
          if (po && po.status === "open" && Array.isArray(po.items)) {
            po.items.forEach(it => {
              if (it.variant_id) {
                inTransit[it.variant_id] = (inTransit[it.variant_id] || 0) + (it.qty || 0);
              }
            });
          }
        });
      }
    } catch (e) {
      console.warn("[restock-cron] Error leyendo POs:", e.message);
    }

    // 4. Compute
    const skus = Object.values(variants).map(v => {
      const vel7  = v.sales_7d  / 7;
      const vel30 = v.sales_30d / 30;
      const vel90 = v.sales_90d / 90;
      const velocity_per_day = vel7 > 0
        ? (vel7 * 0.5 + vel30 * 0.3 + vel90 * 0.2)
        : (vel30 * 0.6 + vel90 * 0.4);

      const safety_stock  = velocity_per_day * safety;
      const reorder_point = velocity_per_day * leadTime + safety_stock;
      const target_stock  = velocity_per_day * (leadTime + target);
      const days_until_stockout = velocity_per_day > 0 ? v.stock_current / velocity_per_day : 999;
      const in_transit_qty = inTransit[v.variant_id] || 0;
      const effective_stock = v.stock_current + in_transit_qty;
      const is_active = v.sales_30d > 0 || v.sales_90d >= 3;

      const suggested_order = is_active
        ? Math.max(0, Math.ceil(target_stock - effective_stock))
        : 0;

      let status;
      if (!is_active) {
        status = v.stock_current > 0 ? "dead" : "discontinued";
      } else {
        if (effective_stock <= 0)                            status = "out";
        else if (effective_stock / velocity_per_day < leadTime) status = "critical";
        else if (effective_stock < reorder_point)            status = "alert";
        else if (effective_stock < reorder_point * 1.25)     status = "warn";
        else                                                  status = "ok";
      }

      return {
        ...v,
        velocity_per_day:    Math.round(velocity_per_day * 100) / 100,
        reorder_point:       Math.round(reorder_point),
        target_stock:        Math.round(target_stock),
        suggested_order,
        days_until_stockout: Math.round(days_until_stockout * 10) / 10,
        in_transit_qty,
        status,
      };
    });

    const t3 = Date.now();

    const data = {
      computed_at: new Date().toISOString(),
      params: { lead_time_days: leadTime, safety_days: safety, target_days: target, lookback_days: lookback },
      counts: { variants: skus.length, orders_used: orders.length, products: products.length, in_transit_skus: Object.keys(inTransit).length },
      timing_ms: { products: t1 - t0, orders: t2 - t1, compute: t3 - t2, total: t3 - t0 },
      skus,
    };

    // Save to Firebase (path /restock_snapshot/current)
    const fbResp = await fetch(FB_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!fbResp.ok) {
      const errBody = await fbResp.text();
      throw new Error(`Firebase PUT failed: ${fbResp.status} ${errBody}`);
    }

    return res.status(200).json({
      ok: true,
      computed_at: data.computed_at,
      counts: data.counts,
      timing_ms: data.timing_ms,
      saved_to_firebase: true,
    });
  } catch (e) {
    console.error("[restock-cron] error:", e);
    return res.status(500).json({ error: e.message });
  }
}

async function fetchAllProducts() {
  const startUrl = `https://${STORE}/admin/api/2024-01/products.json`
    + `?limit=250&fields=id,title,images,image,variants`;
  return paginateAll(startUrl, "products");
}

async function fetchAllOrdersWithLineItems(dateMin, dateMax) {
  const startUrl = `https://${STORE}/admin/api/2024-01/orders.json`
    + `?status=any&financial_status=paid`
    + `&created_at_min=${encodeURIComponent(dateMin)}&created_at_max=${encodeURIComponent(dateMax)}`
    + `&limit=250&fields=id,created_at,line_items`;
  return paginateAll(startUrl, "orders");
}
