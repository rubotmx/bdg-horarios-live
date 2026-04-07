// Vercel serverless function — almacena el estado compartido en KV
// Si KV no está configurado, cae a un store en memoria (suficiente para demo)

let memStore = null; // fallback en memoria

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;

  // ── GET: devuelve el estado guardado
  if (req.method === "GET") {
    try {
      if (useKV) {
        const r = await fetch(`${process.env.KV_REST_API_URL}/get/bdg_horarios`, {
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
        });
        const json = await r.json();
        const raw = json.result;
        return res.status(200).json(raw ? JSON.parse(raw) : null);
      }
      return res.status(200).json(memStore);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: guarda el estado
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (useKV) {
        await fetch(`${process.env.KV_REST_API_URL}/set/bdg_horarios`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ value: body })
        });
      } else {
        memStore = JSON.parse(body);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
}
