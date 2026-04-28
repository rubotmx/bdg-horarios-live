// /api/restock — endpoint consolidado del sistema de restock
// Routea por ?action=
//   snapshot      → GET cálculo o lectura de cache (default)
//   cron          → POST/GET protegido por CRON_SECRET, precalcula y guarda
//   pos-list      → GET lista de POs (?status=open opcional)
//   pos-create    → POST crear PO
//   pos-update    → PATCH actualizar PO (?id=)
//   pos-delete    → DELETE eliminar PO (?id=)
//   archive       → POST archivar productos en Shopify
//
// Esto consolida lo que serían 5 funciones serverless en 1 sola para
// quedarnos dentro del límite de Vercel Hobby (12 funciones).

import { shopifyFetch, paginateAll, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";
const FB_BASE = "https://bdg-horarios-default-rtdb.firebaseio.com";

// Cache en memoria del lambda (snapshot)
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FB_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action || "snapshot";

  try {
    switch (action) {
      case "snapshot":     return await handleSnapshot(req, res, false);
      case "cron":         return await handleSnapshot(req, res, true);
      case "pos-list":     return await handlePosList(req, res);
      case "pos-create":   return await handlePosCreate(req, res);
      case "pos-update":   return await handlePosUpdate(req, res);
      case "pos-delete":   return await handlePosDelete(req, res);
      case "archive":      return await handleArchive(req, res);
      default:             return res.status(400).json({ error: `action desconocida: ${action}` });
    }
  } catch (e) {
    console.error(`[restock:${action}] error:`, e);
    return res.status(500).json({ error: e.message });
  }
}

// ── SNAPSHOT (compute o lee cache) ────────────────────────────────────────────
async function handleSnapshot(req, res, isCron) {
  // Si es cron: requiere CRON_SECRET
  if (isCron) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const leadTime = parseInt(req.query.lead_time_days) || 14;
  const safety   = parseInt(req.query.safety_days)    || 7;
  const target   = parseInt(req.query.target_days)    || 30;
  const lookback = parseInt(req.query.lookback_days)  || 90;
  const force    = req.query.force === "1" || isCron;
  const usingDefaults = (leadTime === 14 && safety === 7 && target === 30 && lookback === 90);
  const cacheKey = `${leadTime}|${safety}|${target}|${lookback}`;

  // Lectura: cache memoria → cache Firebase → recalcular
  if (!force) {
    if (_cache && _cache.key === cacheKey && Date.now() - _cacheAt < CACHE_TTL_MS) {
      return res.status(200).json({ ..._cache.data, _cache: "HIT_MEMORY" });
    }
    if (usingDefaults) {
      try {
        const fbResp = await fetch(`${FB_BASE}/restock_snapshot/current.json`);
        if (fbResp.ok) {
          const fbData = await fbResp.json();
          if (fbData && fbData.computed_at) {
            const ageMs = Date.now() - new Date(fbData.computed_at).getTime();
            if (ageMs < FB_CACHE_MAX_AGE_MS) {
              _cache = { key: cacheKey, data: fbData };
              _cacheAt = Date.now();
              return res.status(200).json({ ...fbData, _cache: "HIT_FIREBASE", _cache_age_minutes: Math.round(ageMs / 60000) });
            }
          }
        }
      } catch (e) {
        console.warn("[snapshot] FB cache read failed:", e.message);
      }
    }
  }

  // Recalcular
  const t0 = Date.now();
  const products = await fetchAllProducts();
  const t1 = Date.now();

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

  const now = new Date();
  const dateMin = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000).toISOString();
  const dateMax = now.toISOString();
  const orders  = await fetchAllOrdersWithLineItems(dateMin, dateMax);
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

  // POs en tránsito
  let inTransit = {};
  try {
    const fbPos = await fetch(`${FB_BASE}/restock_pos.json`);
    if (fbPos.ok) {
      const pos = (await fbPos.json()) || {};
      Object.values(pos).forEach(po => {
        if (po && po.status === "open" && Array.isArray(po.items)) {
          po.items.forEach(it => {
            if (it.variant_id) inTransit[it.variant_id] = (inTransit[it.variant_id] || 0) + (it.qty || 0);
          });
        }
      });
    }
  } catch (e) { console.warn("[snapshot] POs read failed:", e.message); }

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
    const suggested_order = is_active ? Math.max(0, Math.ceil(target_stock - effective_stock)) : 0;

    let status;
    if (!is_active) {
      status = v.stock_current > 0 ? "dead" : "discontinued";
    } else {
      if (effective_stock <= 0)                              status = "out";
      else if (effective_stock / velocity_per_day < leadTime) status = "critical";
      else if (effective_stock < reorder_point)              status = "alert";
      else if (effective_stock < reorder_point * 1.25)       status = "warn";
      else                                                    status = "ok";
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

  _cache = { key: cacheKey, data };
  _cacheAt = Date.now();

  // Cron: guardar en Firebase
  if (isCron) {
    const fbResp = await fetch(`${FB_BASE}/restock_snapshot/current.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!fbResp.ok) console.warn("[cron] FB write failed:", fbResp.status);
    return res.status(200).json({ ok: true, computed_at: data.computed_at, counts: data.counts, timing_ms: data.timing_ms, saved_to_firebase: fbResp.ok });
  }

  return res.status(200).json({ ...data, _cache: "MISS" });
}

// ── POs ──────────────────────────────────────────────────────────────────────
async function handlePosList(req, res) {
  const filterStatus = req.query.status;
  const r = await fetch(`${FB_BASE}/restock_pos.json`);
  if (!r.ok) throw new Error(`Firebase GET failed: ${r.status}`);
  const data = (await r.json()) || {};
  let pos = Object.values(data);
  if (filterStatus) pos = pos.filter(p => p.status === filterStatus);
  pos.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return res.status(200).json({ pos, count: pos.length });
}

async function handlePosCreate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return res.status(400).json({ error: "items[] requerido" });
  for (const it of items) {
    if (!it.variant_id || !it.qty || it.qty <= 0) return res.status(400).json({ error: `item inválido: ${JSON.stringify(it)}` });
  }
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 9000 + 1000);
  const po_id = `PO-${ymd}-${seq}`;
  const po = {
    po_id,
    created_at: now.getTime(),
    created_by: body.created_by || "—",
    eta_date:   body.eta_date || null,
    status:     "open",
    notes:      body.notes || "",
    items: items.map(it => ({
      variant_id:    it.variant_id,
      sku:           it.sku || "",
      product_title: it.product_title || "",
      size:          it.size || "",
      qty:           Math.max(1, Math.round(it.qty)),
    })),
    total_pares: items.reduce((s, it) => s + Math.max(1, Math.round(it.qty)), 0),
  };
  const r = await fetch(`${FB_BASE}/restock_pos/${po_id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(po),
  });
  if (!r.ok) throw new Error(`Firebase PUT failed: ${r.status} ${await r.text()}`);
  return res.status(200).json({ ok: true, po });
}

async function handlePosUpdate(req, res) {
  if (req.method !== "PATCH" && req.method !== "POST") return res.status(405).json({ error: "PATCH/POST only" });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id requerido" });
  const body = req.body || {};
  const allowed = ["status", "eta_date", "notes"];
  const update = {};
  for (const k of allowed) if (body[k] !== undefined) update[k] = body[k];
  if (body.status && !["open","received","cancelled"].includes(body.status)) {
    return res.status(400).json({ error: "status inválido" });
  }
  if (Object.keys(update).length === 0) return res.status(400).json({ error: "nada que actualizar" });

  const getR = await fetch(`${FB_BASE}/restock_pos/${id}.json`);
  if (!getR.ok) throw new Error(`Firebase GET failed: ${getR.status}`);
  const existing = await getR.json();
  if (!existing) return res.status(404).json({ error: "PO no encontrada" });

  if (update.status === "received")  update.received_at  = Date.now();
  if (update.status === "cancelled") update.cancelled_at = Date.now();

  const merged = { ...existing, ...update };
  const r = await fetch(`${FB_BASE}/restock_pos/${id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  if (!r.ok) throw new Error(`Firebase PUT failed: ${r.status}`);
  return res.status(200).json({ ok: true, po: merged });
}

async function handlePosDelete(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id requerido" });
  const r = await fetch(`${FB_BASE}/restock_pos/${id}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`Firebase DELETE failed: ${r.status}`);
  return res.status(200).json({ ok: true });
}

// ── ARCHIVE ──────────────────────────────────────────────────────────────────
async function handleArchive(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = req.body || {};
  const ids = Array.isArray(body.product_ids) ? body.product_ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "product_ids[] requerido" });
  if (ids.length > 200) return res.status(400).json({ error: "máximo 200 por llamada" });

  const results = [];
  let succeeded = 0, failed = 0;

  for (const id of ids) {
    try {
      const r = await shopifyFetch(`/products/${id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: { id, status: "archived" } }),
      });
      if (r.ok) { succeeded++; results.push({ id, ok: true }); }
      else { failed++; const eb = await r.text(); results.push({ id, ok: false, error: `${r.status}: ${eb.slice(0,200)}` }); }
      await new Promise(resolve => setTimeout(resolve, 600));
    } catch (e) { failed++; results.push({ id, ok: false, error: e.message }); }
  }
  return res.status(200).json({ ok: failed === 0, succeeded, failed, results });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function fetchAllProducts() {
  const startUrl = `https://${STORE}/admin/api/2024-01/products.json?limit=250&fields=id,title,images,image,variants`;
  return paginateAll(startUrl, "products");
}
async function fetchAllOrdersWithLineItems(dateMin, dateMax) {
  const startUrl = `https://${STORE}/admin/api/2024-01/orders.json?status=any&financial_status=paid&created_at_min=${encodeURIComponent(dateMin)}&created_at_max=${encodeURIComponent(dateMax)}&limit=250&fields=id,created_at,line_items`;
  return paginateAll(startUrl, "orders");
}
