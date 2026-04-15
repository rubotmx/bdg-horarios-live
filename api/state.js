// Vercel serverless function — almacena el estado compartido en KV
// Si KV no está configurado → store en memoria como fallback
import { setCors } from "./_shopify.js";

let memStore = null;

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();

  const useKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN;
  if (!useKV) {
    res.setHeader("X-Storage", "memory"); // Avisa al cliente que el estado no es persistente
  }

  if (req.method === "GET") {
    try {
      if (useKV) {
        const r = await fetch(`${process.env.KV_REST_API_URL}/get/bdg_horarios`, {
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
        });
        const json = await r.json();
        return res.status(200).json(json.result ? JSON.parse(json.result) : null);
      }
      return res.status(200).json(memStore);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (useKV) {
        await fetch(`${process.env.KV_REST_API_URL}/set/bdg_horarios`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ value: body }),
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
