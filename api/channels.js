// GET  /api/channels?week=2026-04-09  → devuelve datos manuales guardados
// POST /api/channels                  → guarda { week, channel, gmv }
import { setCors } from "./_shopify.js";

const FB = "https://bdg-horarios-default-rtdb.firebaseio.com/bdg_horarios_v2/pulse_channels";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { week } = req.query;
    if (!week) return res.status(400).json({ error: "week requerido" });
    try {
      const r = await fetch(`${FB}/${week}.json`);
      return res.status(200).json((await r.json()) || {});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    const { week, channel, gmv } = req.body || {};
    if (!week || !channel) return res.status(400).json({ error: "week y channel requeridos" });

    // Validar que gmv sea numérico
    const gmvNum = parseFloat(gmv);
    if (gmv !== undefined && isNaN(gmvNum)) {
      return res.status(400).json({ error: "gmv debe ser un número" });
    }

    try {
      const fbRes = await fetch(`${FB}/${week}/${channel}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isNaN(gmvNum) ? 0 : gmvNum),
      });
      if (!fbRes.ok) {
        // No fallar silenciosamente: si Firebase rechaza (rules, red, etc.) devolver el error real
        const txt = await fbRes.text();
        console.error(`[channels] Firebase rechazó escritura: ${fbRes.status} ${txt}`);
        return res.status(502).json({ error: `Firebase ${fbRes.status}: ${txt.slice(0, 200)}` });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
}
