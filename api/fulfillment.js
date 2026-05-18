// Módulo Logística — órdenes pendientes de fulfillment en Shopify
import { paginateAll, setCors } from "./_shopify.js";

const STORE = "baladigalamx.myshopify.com";

// Cache 2 minutos — el equipo operativo hace refresh frecuente
const _cache = new Map();
const TTL = 2 * 60 * 1000;
function getCached(k) { const e = _cache.get(k); return e && Date.now() < e.expiry ? e.data : null; }
function setCache(k, d) { _cache.set(k, { data: d, expiry: Date.now() + TTL }); }

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const hit = getCached("fulfillment");
  if (hit) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(hit); }

  try {
    const fields = [
      "id", "order_number", "created_at", "fulfillment_status",
      "financial_status", "shipping_address", "line_items",
      "source_name", "total_price",
    ].join(",");

    const baseUrl = (status) =>
      `https://${STORE}/admin/api/2024-01/orders.json`
      + `?status=open&financial_status=paid&fulfillment_status=${status}`
      + `&limit=250&fields=${fields}`;

    // Fetch unfulfilled + partial en paralelo
    const [unfulfilled, partial] = await Promise.all([
      paginateAll(baseUrl("unfulfilled"), "orders"),
      paginateAll(baseUrl("partial"),     "orders"),
    ]);

    const allOrders = [...unfulfilled, ...partial];
    const nowMs = Date.now();

    const orders = allOrders.map(o => {
      const days = Math.floor((nowMs - new Date(o.created_at).getTime()) / 86400000);
      const urgency = days >= 5 ? "critical" : days >= 2 ? "warning" : "ok";

      const addr = o.shipping_address || {};
      const customer = [addr.first_name, addr.last_name].filter(Boolean).join(" ") || "—";
      const city = addr.city || addr.province || "—";

      const items = (o.line_items || []).map(li => ({
        title:   li.title,
        variant: li.variant_title || null,
        qty:     li.quantity,
      }));

      return {
        id:           o.id,
        order_number: o.order_number,
        created_at:   o.created_at,
        days_waiting: days,
        urgency,
        source:       o.source_name || "web",
        total:        parseFloat(o.total_price),
        customer,
        city,
        items,
        shopify_url:  `https://${STORE}/admin/orders/${o.id}`,
      };
    });

    // Sort: critical first → warning → ok
    // Within each urgency group: TikTok first, then by days_waiting desc
    const urgOrder = { critical: 0, warning: 1, ok: 2 };
    const isTikTok = (o) => (o.source || '').toLowerCase() === 'tiktok' ? 0 : 1;
    orders.sort((a, b) => {
      const ud = urgOrder[a.urgency] - urgOrder[b.urgency];
      if (ud !== 0) return ud;
      const td = isTikTok(a) - isTikTok(b);
      if (td !== 0) return td;
      return b.days_waiting - a.days_waiting;
    });

    const critical = orders.filter(o => o.urgency === "critical").length;
    const warning  = orders.filter(o => o.urgency === "warning").length;
    const ok       = orders.filter(o => o.urgency === "ok").length;
    const oldest   = orders.length > 0 ? orders[0].days_waiting : 0;

    const result = {
      summary: {
        total: orders.length,
        critical,
        warning,
        ok,
        oldest_days: oldest,
      },
      orders,
      ts: nowMs,
    };

    setCache("fulfillment", result);
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
