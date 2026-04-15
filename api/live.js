// Módulo En Vivo — ventas Shopify hoy + gasto Meta Ads en tiempo real
import { shopifyFetch, nextPageUrl, setCors } from "./_shopify.js";

const META_ACCOUNT = process.env.META_ACCOUNT_ID;

const _cache = new Map();
const LIVE_TTL = 60 * 1000; // 60 s

function getCached(k) { const e = _cache.get(k); return e && Date.now() < e.expiry ? e.data : null; }
function setCache(k, d) { _cache.set(k, { data: d, expiry: Date.now() + LIVE_TTL }); }

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const hit = getCached("live");
  if (hit) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(hit); }

  try {
    const [shopify, meta] = await Promise.all([fetchShopifyToday(), fetchMetaToday()]);
    const result = { shopify, meta, ts: Date.now() };
    setCache("live", result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function fetchShopifyToday() {
  const mxDate = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  const dateMin = `${mxDate}T00:00:00-06:00`;

  const orders = [];
  let url = `https://baladigalamx.myshopify.com/admin/api/2024-01/orders.json`
    + `?status=any&financial_status=paid&limit=250`
    + `&fields=id,created_at,total_price,line_items,source_name`
    + `&created_at_min=${encodeURIComponent(dateMin)}`;

  while (url) {
    const r = await shopifyFetch(url);
    if (!r.ok) break;
    const data = await r.json();
    orders.push(...(data.orders || []));
    url = nextPageUrl(r.headers.get("Link") || "");
  }

  const gmv = orders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const byProduct = {}, byHour = {}, byChannel = {};

  for (const o of orders) {
    const h = parseInt((o.created_at || "").slice(11, 13));
    if (!byHour[h]) byHour[h] = { orders: 0, gmv: 0 };
    byHour[h].orders++;
    byHour[h].gmv += parseFloat(o.total_price);

    const ch = o.source_name || "web";
    byChannel[ch] = (byChannel[ch] || 0) + parseFloat(o.total_price);

    for (const item of (o.line_items || [])) {
      const k = item.title;
      if (!byProduct[k]) byProduct[k] = { title: k, units: 0, gmv: 0 };
      byProduct[k].units += item.quantity;
      byProduct[k].gmv  += parseFloat(item.price) * item.quantity;
    }
  }

  return {
    date:         mxDate,
    orders:       orders.length,
    gmv:          Math.round(gmv * 100) / 100,
    aov:          orders.length > 0 ? Math.round(gmv / orders.length * 100) / 100 : 0,
    top_products: Object.values(byProduct).sort((a, b) => b.gmv - a.gmv).slice(0, 10),
    by_hour:      byHour,
    by_channel:   byChannel,
  };
}

async function fetchMetaToday() {
  const META_TOKEN = process.env.META_TOKEN;
  if (!META_TOKEN || !META_ACCOUNT) return { configured: false };
  try {
    const [insights, ads] = await Promise.all([
      fetchMetaInsights(META_TOKEN),
      fetchActiveAds(META_TOKEN),
    ]);
    return { configured: true, ...insights, active_ads: ads };
  } catch (e) {
    return { configured: true, error: e.message };
  }
}

async function fetchMetaInsights(token) {
  const fields = "spend,impressions,clicks,reach,ctr,cpc,actions,action_values";
  // Token va en Authorization header, no en query string
  const url = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/insights?fields=${fields}&date_preset=today`;
  const r    = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
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
    const fields = "id,name,effective_status,creative{thumbnail_url,image_url,title,body,object_type}";
    const url = `https://graph.facebook.com/v19.0/${META_ACCOUNT}/ads`
      + `?fields=${encodeURIComponent(fields)}&effective_status=["ACTIVE"]&limit=50`;
    const r    = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (data.error || !data.data) return [];
    return data.data.map(ad => ({
      id:        ad.id,
      name:      ad.name,
      status:    ad.effective_status,
      thumbnail: ad.creative?.thumbnail_url || ad.creative?.image_url || null,
      title:     ad.creative?.title  || null,
      body:      ad.creative?.body   || null,
      type:      ad.creative?.object_type || null,
    })).filter(ad => ad.thumbnail);
  } catch (e) {
    return [];
  }
}
