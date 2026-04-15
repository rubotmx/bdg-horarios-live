// POST /api/auth — verifica PIN sin exponerlo en el frontend
// Body: { pin: "xxxx", module: "hq" | "pulse" | "catalogo" }
// Response: { ok: true } | { ok: false }
//
// Variables de entorno necesarias en Vercel:
//   PIN_HQ        → PIN para Pulse, Catálogo y acceso general HQ
//   PIN_PULSE     → PIN alternativo solo para Pulse (opcional)
//
// Si las variables no están configuradas: devuelve { ok: true } como fallback
// temporal para no bloquear el sistema durante la migración.

import { setCors } from "./_shopify.js";

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { pin, module: mod } = req.body || {};
  if (!pin) return res.status(400).json({ ok: false, error: "pin requerido" });

  // PINs por módulo desde variables de entorno
  const pins = {
    hq:      process.env.PIN_HQ,
    pulse:   process.env.PIN_PULSE || process.env.PIN_HQ,
    catalogo: process.env.PIN_HQ,
  };

  const expected = pins[mod] || pins.hq;

  // Si no hay env vars configuradas → fallback temporal (no bloquea el sistema)
  if (!expected) {
    console.warn("[auth] PIN_HQ no configurado — modo fallback");
    return res.status(200).json({ ok: true, fallback: true });
  }

  const ok = pin === expected;
  // No loguear el PIN, solo si fue correcto
  console.log(`[auth] módulo=${mod} resultado=${ok ? "OK" : "FAIL"}`);
  return res.status(ok ? 200 : 401).json({ ok });
}
