// Módulo En Vivo — ventas Shopify hoy + comparativo ayer + imágenes + Meta Ads
import { shopifyFetch, nextPageUrl, setCors } from "./_shopify.js";

const STORE        = "baladigalamx.myshopify.com";
const META_ACCOUNT = process.env.META_ACCOUNT_ID;

// Caché principal (60s) y caché de imágenes de producto (30min)
const _cache     = new Map();
const LIVE_TTL   = 60  * 1000;
const IMG_TTL    = 30  * 60 * 1000;
let   _imgCache  = null;
let   _imgExpiry = 0;

function getCached(k)         { const e = _cache.get(k); return e && Date.now() < e.expiry ? e.data : null; }
function setCache(k, d, ttl=LIVE_TTL) { _cache.set(k, { data: d, expiry: Date.now() + ttl }); }

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  // date param: YYYY-MM-DD (Mexico City). If omitted → today
  const reqDate = req.query.date || null;
  const mxToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const isToday = !reqDate || reqDate === mxToday;
  const targetDate = reqDate || mxToday;

  const cacheKey = isToday ? "live" : `hist:${targetDate}`;
  const cacheTTL = isToday ? LIVE_TTL : 24 * 60 * 60 * 1000; // hist: 24h

  const hit = getCached(cacheKey);
  if (hit) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(hit); }

  try {
    const [shopify, meta] = await Promise.all([
      fetchShopifyDay(targetDate, isToday),
      isToday ? fetchMetaToday() : Promise.resolve({ configured: false }),
    ]);
    const result = { shopify, meta, ts: Date.now(), date: targetDate, isToday };
    setCache(cacheKey, result, cacheTTL);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── Imágenes de producto (caché 30min) ────────────────────────────────────────
async function getProductImages() {
  if (_imgCache && Date.now() < _imgExpiry) return _imgCache;
  const images = {};
  let url = `https://${STORE}/admin/api/2024-01/products.json?limit=250&fields=title,images`;
  while (url) {
    const r = await shopifyFetch(url);
    if (!r.ok) break;
    const data = await r.json();
    for (const p of (data.products || [])) {
      if (p.images?.[0]?.src) images[p.title] = p.images[0].src;
    }
    url = nextPageUrl(r.headers.get("Link") || "");
  }
  _imgCache  = images;
  _imgExpiry = Date.now() + IMG_TTL;
  return images;
}

// ── Órdenes de un día específico ──────────────────────────────────────────────
async function fetchDayOrders(mxDate) {
  const orders = [];
  let url = `https://${STORE}/admin/api/2024-01/orders.json`
    + `?status=any&financial_status=paid&limit=250`
    + `&fields=id,created_at,total_price,line_items,source_name`
    + `&created_at_min=${encodeURIComponent(mxDate + "T00:00:00-06:00")}`
    + `&created_at_max=${encodeURIComponent(mxDate + "T23:59:59-06:00")}`;
  while (url) {
    const r = await shopifyFetch(url);
    if (!r.ok) break;
    const data = await r.json();
    orders.push(...(data.orders || []));
    url = nextPageUrl(r.headers.get("Link") || "");
  }
  return orders;
}

// ── Día específico + Ayer (paralelo) + imágenes ──────────────────────────────
async function fetchShopifyDay(mxToday, isToday = true) {
  const mxYesterday = new Date(new Date(mxToday).getTime() - 86400000)
    .toISOString().slice(0, 10);

  const [todayOrders, yesterdayOrders, images, inventory] = await Promise.all([
    fetchDayOrders(mxToday),
    fetchDayOrders(mxYesterday),
    getProductImages(),
    isToday ? fetchFluxInventory() : Promise.resolve([]),
  ]);

  // Current MX time — for "same hour" comparison (only relevant when viewing today)
  const nowMX  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const nowH   = isToday ? nowMX.getHours()   : 23;
  const nowMin = isToday ? nowMX.getMinutes() : 59;

  const yesterdayGmv     = yesterdayOrders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const yesterdayOrders_ = yesterdayOrders.length;

  // Filter yesterday orders up to the same clock time (full-day when viewing history)
  const yesterdaySameHour = yesterdayOrders.filter(o => {
    const oMX  = new Date(new Date(o.created_at).toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    const oH   = oMX.getHours();
    const oMin = oMX.getMinutes();
    return oH < nowH || (oH === nowH && oMin <= nowMin);
  });
  const yesterdayGmvSameHour    = yesterdaySameHour.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const yesterdayOrdersSameHour = yesterdaySameHour.length;

  // ── Procesar hoy ────────────────────────────────────────────────────────────
  const byProduct = {}, byHour = {}, byChannel = {};

  for (const o of todayOrders) {
    const oMX = new Date(new Date(o.created_at).toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    const h   = oMX.getHours();
    const ch  = o.source_name || "web";
    const amt = parseFloat(o.total_price);

    if (!byHour[h])     byHour[h]     = { orders: 0, gmv: 0 };
    if (!byChannel[ch]) byChannel[ch] = { orders: 0, gmv: 0 };
    byHour[h].orders++;    byHour[h].gmv    += amt;
    byChannel[ch].orders++;byChannel[ch].gmv += amt;

    for (const item of (o.line_items || [])) {
      const k = item.title;
      if (!byProduct[k]) byProduct[k] = { title: k, units: 0, gmv: 0, image: images[k] || null };
      byProduct[k].units += item.quantity;
      byProduct[k].gmv   += parseFloat(item.price) * item.quantity;
    }
  }

  // ── Procesar ayer por hora ───────────────────────────────────────────────────
  const yesterdayByHour = {};
  for (const o of yesterdayOrders) {
    const oMX = new Date(new Date(o.created_at).toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    const h   = oMX.getHours();
    if (!yesterdayByHour[h]) yesterdayByHour[h] = { orders: 0, gmv: 0 };
    yesterdayByHour[h].orders++;
    yesterdayByHour[h].gmv += parseFloat(o.total_price);
  }

  // ── Órdenes recientes (últimas 10, para el ticker) ───────────────────────────
  const recentOrders = [...todayOrders]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10)
    .map(o => {
      const oMX = new Date(new Date(o.created_at).toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
      const t   = `${String(oMX.getHours()).padStart(2,'0')}:${String(oMX.getMinutes()).padStart(2,'0')}`;
      const item = o.line_items?.[0];
      return {
        time:    t,
        product: item?.title || '—',
        amount:  Math.round(parseFloat(o.total_price) * 100) / 100,
        channel: o.source_name || 'web',
      };
    });

  const gmv       = todayOrders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const orders    = todayOrders.length;
  const unitsSold = Object.values(byProduct).reduce((s, p) => s + p.units, 0);

  return {
    date:          mxToday,
    orders,
    gmv:           Math.round(gmv * 100) / 100,
    aov:           orders > 0 ? Math.round(gmv / orders * 100) / 100 : 0,
    units_sold:    unitsSold,
    inventory,
    top_products:  Object.values(byProduct).sort((a, b) => b.gmv - a.gmv).slice(0, 10),
    by_hour:       byHour,
    by_channel:    byChannel,
    recent_orders: recentOrders,
    yesterday: {
      gmv:             Math.round(yesterdayGmv          * 100) / 100,
      orders:          yesterdayOrders_,
      gmv_same_hour:   Math.round(yesterdayGmvSameHour  * 100) / 100,
      orders_same_hour: yesterdayOrdersSameHour,
      same_hour_time:  `${String(nowH).padStart(2,'0')}:${String(nowMin).padStart(2,'0')}`,
      by_hour:         yesterdayByHour,
    },
  };
}

// ── Inventario FLUX por talla ─────────────────────────────────────────────────
async function fetchFluxInventory() {
  try {
    const searchUrl = `https://${STORE}/admin/api/2024-01/products.json?title=FLUX&fields=id,title,variants&limit=10`;
    const r = await shopifyFetch(searchUrl);
    if (!r.ok) return [];
    const data = await r.json();
    const product = (data.products || []).find(p => p.title.toUpperCase().includes("FLUX"));
    if (!product) return [];

    const variants = product.variants || [];
    const invIds   = variants.map(v => v.inventory_item_id).filter(Boolean).join(",");
    if (!invIds) return [];

    const invUrl = `https://${STORE}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${invIds}&limit=250`;
    const invR   = await shopifyFetch(invUrl);
    if (!invR.ok) return [];
    const invData = await invR.json();

    const qtyMap = {};
    for (const lv of (invData.inventory_levels || [])) {
      const id = lv.inventory_item_id;
      qtyMap[id] = (qtyMap[id] || 0) + (lv.available || 0);
    }

    return variants
      .filter(v => v.option1)
      .map(v => ({ size: v.option1, quantity: Math.max(0, qtyMap[v.inventory_item_id] || 0) }))
      .sort((a, b) => parseFloat(a.size) - parseFloat(b.size));
  } catch {
    return [];
  }
}

// ── Meta Ads ──────────────────────────────────────────────────────────────────
async function fetchMetaToday() {
  const META_TOKEN = process.env.META_TOKEN;
  if (!META_TOKEN || !META_ACCOUNT) return { configured: false };
  try {
    const [insights, ads, campaigns] = await Promise.all([
      fetchMetaInsights(META_TOKEN),
      fetchActiveAds(META_TOKEN),
      fetchCampaignData(META_TOKEN),
    ]);
    const anomalies = detectAnomalies(campaigns, ads);
    return { configured: true, ...insights, active_ads: ads, campaigns, anomalies };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

async function fetchMetaInsights(token) {
  const fields = "spend,impressions,clicks,reach,ctr,cpc,actions,action_values";
  const url    = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/insights?fields=${fields}&date_preset=today`;
  const r      = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data   = await r.json();
  if (data.error) return { error: data.error.message };
  const ins       = data.data?.[0] || {};
  const purchases = (ins.actions       || []).find(a => a.action_type === "purchase");
  const revenue   = (ins.action_values || []).find(a => a.action_type === "purchase");
  return {
    spend:          parseFloat(ins.spend       || 0),
    impressions:    parseInt(ins.impressions   || 0),
    clicks:         parseInt(ins.clicks        || 0),
    reach:          parseInt(ins.reach         || 0),
    ctr:            parseFloat(ins.ctr         || 0),
    cpc:            parseFloat(ins.cpc         || 0),
    purchases:      purchases ? parseInt(purchases.value)  : 0,
    purchase_value: revenue   ? parseFloat(revenue.value)  : 0,
  };
}

async function fetchActiveAds(token) {
  try {
    const fields = [
      "id,name,effective_status,",
      "creative{id,object_type,image_url,thumbnail_url,title,body,",
      "asset_feed_spec{images{url}},",
      "object_story_spec{photo_data{image_url},video_data{image_url}}}",
    ].join("");
    const adsUrl      = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/ads`
      + `?fields=${encodeURIComponent(fields)}&effective_status=["ACTIVE"]&limit=50`;
    const insUrl      = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/insights`
      + `?fields=ad_id,spend,impressions,clicks,cpm,ctr,cpc,frequency,actions,action_values`
      + `&date_preset=today&level=ad&limit=100`;

    const [adsRes, insRes] = await Promise.all([
      fetch(adsUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(insUrl, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const adsData = await adsRes.json();
    if (adsData.error || !adsData.data) return [];

    // Build insights map by ad_id
    const insightsMap = {};
    if (insRes.ok) {
      const insData = await insRes.json();
      for (const ins of (insData.data || [])) {
        const purchases = (ins.actions       || []).find(a => a.action_type === "purchase");
        const revenue   = (ins.action_values || []).find(a => a.action_type === "purchase");
        insightsMap[ins.ad_id] = {
          spend:       parseFloat(ins.spend       || 0),
          impressions: parseInt(ins.impressions   || 0),
          clicks:      parseInt(ins.clicks        || 0),
          cpm:         parseFloat(ins.cpm         || 0),
          ctr:         parseFloat(ins.ctr         || 0),
          cpc:         parseFloat(ins.cpc         || 0),
          frequency:   parseFloat(ins.frequency   || 0),
          purchases:   purchases ? parseInt(purchases.value)  : 0,
          revenue:     revenue   ? parseFloat(revenue.value)  : 0,
        };
      }
    }

    const ads = adsData.data.map(ad => {
      const c = ad.creative || {};
      const imgUrl =
        c.image_url                                 ||
        c.object_story_spec?.photo_data?.image_url  ||
        c.object_story_spec?.video_data?.image_url  ||
        c.asset_feed_spec?.images?.[0]?.url         ||
        c.thumbnail_url                             || null;
      return {
        id:        ad.id,
        name:      ad.name,
        type:      c.object_type || null,
        thumbnail: imgUrl,
        body:      c.body || null,
        insights:  insightsMap[ad.id] || null,
      };
    }).filter(ad => ad.thumbnail);

    // Sort by spend desc so top spenders come first
    ads.sort((a, b) => (b.insights?.spend || 0) - (a.insights?.spend || 0));
    return ads;
  } catch (e) {
    return [];
  }
}

// ── Campañas con pacing ───────────────────────────────────────────────────────
const CPM_BENCHMARK = 67; // MXN referencia BDG 2026

async function fetchCampaignData(token) {
  try {
    const campUrl = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/campaigns`
      + `?fields=${encodeURIComponent("id,name,status,daily_budget,budget_remaining")}`
      + `&effective_status=["ACTIVE"]&limit=50`;
    const insUrl  = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/insights`
      + `?fields=campaign_id,campaign_name,spend,impressions,clicks,cpm,ctr,cpc,frequency,actions,action_values`
      + `&date_preset=today&level=campaign&limit=100`;

    const [campRes, insRes] = await Promise.all([
      fetch(campUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(insUrl,  { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const campData = await campRes.json();
    if (campData.error || !campData.data) return [];

    const insMap = {};
    if (insRes.ok) {
      const insData = await insRes.json();
      for (const ins of (insData.data || [])) {
        const purchases = (ins.actions       || []).find(a => a.action_type === "purchase");
        const revenue   = (ins.action_values || []).find(a => a.action_type === "purchase");
        insMap[ins.campaign_id] = {
          spend:     parseFloat(ins.spend     || 0),
          cpm:       parseFloat(ins.cpm       || 0),
          ctr:       parseFloat(ins.ctr       || 0),
          cpc:       parseFloat(ins.cpc       || 0),
          frequency: parseFloat(ins.frequency || 0),
          clicks:    parseInt(ins.clicks      || 0),
          purchases: purchases ? parseInt(purchases.value)  : 0,
          revenue:   revenue   ? parseFloat(revenue.value)  : 0,
        };
      }
    }

    // MX current hour for pacing expected
    const nowH    = new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City", hour: "2-digit", hour12: false });
    const hourPct = Math.min(parseInt(nowH) / 24, 1);

    return campData.data.map(c => {
      const ins    = insMap[c.id] || {};
      const budget = parseFloat(c.daily_budget || 0) / 100; // centavos → pesos
      const spend  = ins.spend || 0;
      const pacing = budget > 0 ? spend / budget : null;
      const pacingExpected = budget > 0 ? hourPct : null;
      return {
        id:              c.id,
        name:            c.name,
        budget,
        spend,
        pacing,
        pacing_expected: pacingExpected,
        cpm:             ins.cpm       || 0,
        ctr:             ins.ctr       || 0,
        cpc:             ins.cpc       || 0,
        frequency:       ins.frequency || 0,
        clicks:          ins.clicks    || 0,
        purchases:       ins.purchases || 0,
        revenue:         ins.revenue   || 0,
        cpm_vs_bench:    ins.cpm > 0 ? ins.cpm / CPM_BENCHMARK : null,
      };
    }).sort((a, b) => b.spend - a.spend);
  } catch {
    return [];
  }
}

// ── Detección de anomalías ────────────────────────────────────────────────────
function detectAnomalies(campaigns, ads) {
  const alerts = [];
  for (const c of campaigns) {
    if (c.budget > 0 && c.spend > c.budget * 1.02) {
      alerts.push({ level: "red", msg: `${c.name} — overspend ($${Math.round(c.spend - c.budget)} sobre budget)` });
    }
    if (c.pacing !== null && c.pacing_expected !== null && c.pacing_expected > 0.3 && c.spend < c.budget * 0.05) {
      alerts.push({ level: "red", msg: `${c.name} — sin entregar ($${Math.round(c.spend)} de $${Math.round(c.budget)})` });
    }
    if (c.cpm > CPM_BENCHMARK * 1.8) {
      alerts.push({ level: "yellow", msg: `${c.name} — CPM $${Math.round(c.cpm)} (×${(c.cpm / CPM_BENCHMARK).toFixed(1)} benchmark)` });
    }
  }
  for (const ad of ads) {
    const freq = ad.insights?.frequency || 0;
    if (freq >= 2.5) {
      alerts.push({ level: "yellow", msg: `Creative fatigado: ${ad.name.slice(0, 40)} — freq ${freq.toFixed(1)}` });
    }
  }
  return alerts;
}
