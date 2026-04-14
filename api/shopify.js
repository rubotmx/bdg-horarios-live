// Proxy Shopify Admin API — todos los canales, con resumen agregado
const STORE = "baladigalamx.myshopify.com";
const TOKEN = process.env.SHOPIFY_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { date_min, date_max, mode = "orders" } = req.query;

  if (mode === "products") {
    return handleProducts(req, res);
  }

  if (!date_min || !date_max) {
    return res.status(400).json({ error: "date_min y date_max requeridos" });
  }

  try {
    // ── Paginación completa de órdenes ────────────────────────────────────────
    const orders = [];
    let url =
      `https://${STORE}/admin/api/2024-01/orders.json` +
      `?status=any&financial_status=paid` +
      `&created_at_min=${date_min}&created_at_max=${date_max}` +
      `&limit=250&fields=id,created_at,total_price,subtotal_price,source_name,` +
      `financial_status,fulfillment_status,line_items,discount_codes,total_discounts`;

    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
      if (!r.ok) return res.status(r.status).json({ error: `Shopify ${r.status}` });
      const data = await r.json();
      const batch = (data.orders || []).filter(o => parseFloat(o.total_price) > 0);
      orders.push(...batch);

      const link = r.headers.get("Link") || "";
      url = null;
      for (const part of link.split(",")) {
        if (part.includes('rel="next"')) {
          url = part.split(";")[0].trim().replace(/[<>]/g, "");
        }
      }
    }

    // ── Agregar por canal ─────────────────────────────────────────────────────
    const bySource = {};
    const byDay    = {};
    const byProduct = {};

    for (const o of orders) {
      const src   = o.source_name || "web";
      const day   = o.created_at.slice(0, 10);
      const price = parseFloat(o.total_price);

      // Por canal
      if (!bySource[src]) bySource[src] = { orders: 0, gmv: 0 };
      bySource[src].orders++;
      bySource[src].gmv += price;

      // Por día
      if (!byDay[day]) byDay[day] = { orders: 0, gmv: 0 };
      byDay[day].orders++;
      byDay[day].gmv += price;

      // Por producto
      for (const item of (o.line_items || [])) {
        const title = item.title;
        if (!byProduct[title]) byProduct[title] = { units: 0, gmv: 0 };
        byProduct[title].units  += item.quantity;
        byProduct[title].gmv   += parseFloat(item.price) * item.quantity;
      }
    }

    const totalGMV    = orders.reduce((s, o) => s + parseFloat(o.total_price), 0);
    const totalOrders = orders.length;
    const aov         = totalOrders > 0 ? totalGMV / totalOrders : 0;

    const topProducts = Object.entries(byProduct)
      .map(([title, v]) => ({ title, ...v }))
      .sort((a, b) => b.gmv - a.gmv)
      .slice(0, 10);

    return res.status(200).json({
      summary: {
        total_orders: totalOrders,
        total_gmv:    Math.round(totalGMV * 100) / 100,
        aov:          Math.round(aov * 100) / 100,
      },
      by_source:   bySource,
      by_day:      byDay,
      top_products: topProducts,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function handleProducts(req, res) {
  try {
    const products = [];
    let url = `https://${STORE}/admin/api/2024-01/products.json?limit=250&fields=id,title,variants,product_type,status`;

    while (url) {
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
      if (!r.ok) return res.status(r.status).json({ error: `Shopify ${r.status}` });
      const data = await r.json();
      products.push(...(data.products || []));

      const link = r.headers.get("Link") || "";
      url = null;
      for (const part of link.split(",")) {
        if (part.includes('rel="next"')) {
          url = part.split(";")[0].trim().replace(/[<>]/g, "");
        }
      }
    }

    return res.status(200).json({ products });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
