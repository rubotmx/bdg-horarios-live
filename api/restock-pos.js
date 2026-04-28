// /api/restock-pos — CRUD de órdenes de compra (POs) en tránsito
//
// Storage: Firebase Realtime DB → /restock_pos/{po_id}
//
// Estructura de PO:
//   {
//     po_id: "PO-20260428-001",
//     created_at: 1729...,
//     created_by: "Rubén",
//     eta_date: "2026-05-12",
//     status: "open" | "received" | "cancelled",
//     notes: "...",
//     items: [
//       { variant_id, sku, product_title, size, qty }
//     ]
//   }
//
// Endpoints:
//   GET  /api/restock-pos              → lista todas las POs
//   GET  /api/restock-pos?status=open  → solo abiertas
//   POST /api/restock-pos              → crea PO (body = { eta_date, notes, items, created_by })
//   PATCH /api/restock-pos?id=XXX      → actualiza status (body = { status })

import { setCors } from "./_shopify.js";

const FB_BASE = "https://bdg-horarios-default-rtdb.firebaseio.com/restock_pos";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET")    return await handleGet(req, res);
    if (req.method === "POST")   return await handlePost(req, res);
    if (req.method === "PATCH")  return await handlePatch(req, res);
    if (req.method === "DELETE") return await handleDelete(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[restock-pos] error:", e);
    return res.status(500).json({ error: e.message });
  }
}

async function handleGet(req, res) {
  const filterStatus = req.query.status;
  const r = await fetch(`${FB_BASE}.json`);
  if (!r.ok) throw new Error(`Firebase GET failed: ${r.status}`);
  const data = (await r.json()) || {};
  let pos = Object.values(data);

  if (filterStatus) pos = pos.filter(p => p.status === filterStatus);

  // Ordenar por created_at desc
  pos.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return res.status(200).json({ pos, count: pos.length });
}

async function handlePost(req, res) {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (items.length === 0) {
    return res.status(400).json({ error: "items[] requerido (no vacío)" });
  }

  // Validar cada item
  for (const it of items) {
    if (!it.variant_id || !it.qty || it.qty <= 0) {
      return res.status(400).json({ error: `item inválido: ${JSON.stringify(it)}` });
    }
  }

  // Generar PO ID
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
    items:      items.map(it => ({
      variant_id:    it.variant_id,
      sku:           it.sku || "",
      product_title: it.product_title || "",
      size:          it.size || "",
      qty:           Math.max(1, Math.round(it.qty)),
    })),
    total_pares: items.reduce((s, it) => s + Math.max(1, Math.round(it.qty)), 0),
  };

  const r = await fetch(`${FB_BASE}/${po_id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(po),
  });
  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`Firebase PUT failed: ${r.status} ${errBody}`);
  }

  return res.status(200).json({ ok: true, po });
}

async function handlePatch(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id requerido en query" });

  const body = req.body || {};
  const allowed = ["status", "eta_date", "notes"];
  const update = {};
  for (const k of allowed) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  if (body.status && !["open", "received", "cancelled"].includes(body.status)) {
    return res.status(400).json({ error: "status debe ser open|received|cancelled" });
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "nada que actualizar" });
  }

  // Obtener PO existente
  const getR = await fetch(`${FB_BASE}/${id}.json`);
  if (!getR.ok) throw new Error(`Firebase GET failed: ${getR.status}`);
  const existing = await getR.json();
  if (!existing) return res.status(404).json({ error: "PO no encontrada" });

  if (update.status === "received") update.received_at = Date.now();
  if (update.status === "cancelled") update.cancelled_at = Date.now();

  const merged = { ...existing, ...update };
  const r = await fetch(`${FB_BASE}/${id}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  if (!r.ok) throw new Error(`Firebase PUT failed: ${r.status}`);

  return res.status(200).json({ ok: true, po: merged });
}

async function handleDelete(req, res) {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id requerido en query" });

  const r = await fetch(`${FB_BASE}/${id}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`Firebase DELETE failed: ${r.status}`);

  return res.status(200).json({ ok: true });
}
