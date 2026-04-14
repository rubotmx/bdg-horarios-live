// GET  /api/channels?week=2026-04-09  → devuelve datos manuales guardados
// POST /api/channels                  → guarda { week, channel, gmv }
const FB = "https://bdg-horarios-default-rtdb.firebaseio.com/bdg_horarios_v2/pulse_channels";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const { week } = req.query;
    if (!week) return res.status(400).json({ error: "week requerido" });
    const r = await fetch(`${FB}/${week}.json`);
    return res.status(200).json((await r.json()) || {});
  }

  if (req.method === "POST") {
    const { week, channel, gmv } = req.body || {};
    if (!week || !channel) return res.status(400).json({ error: "week y channel requeridos" });
    await fetch(`${FB}/${week}/${channel}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gmv ?? 0),
    });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
