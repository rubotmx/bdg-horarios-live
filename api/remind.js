// Cron job — Recordatorios de sesiones LIVE
// Se ejecuta diario a las 8:00am México (14:00 UTC)
// Manda WhatsApp vía Meta Cloud API a anfitrionas y backends asignados al día siguiente

const FB_URL          = "https://bdg-horarios-default-rtdb.firebaseio.com/bdg_horarios_v2";
const WA_PHONE_ID     = "999898826547909";
const WA_API_BASE     = `https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`;
const DAYS_ES         = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

export default async function handler(req, res) {
  // Verificar que viene de Vercel Cron (o llamada manual con el secret)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const waToken = process.env.WHATSAPP_TOKEN;

  try {
    // ── 1. Leer Firebase ──────────────────────────────────────────────────────
    const [slotsRes, picksRes, membersRes] = await Promise.all([
      fetch(`${FB_URL}/slots.json`),
      fetch(`${FB_URL}/picks.json`),
      fetch(`${FB_URL}/members.json`),
    ]);
    const slots   = await slotsRes.json()   || [];
    const picks   = await picksRes.json()   || [];
    const members = await membersRes.json() || [];

    // ── 2. Sesiones de mañana (hora México UTC-6) ─────────────────────────────
    const nowMX      = new Date(new Date().getTime() + (-6 * 60 * 60000));
    const tomorrow   = new Date(nowMX);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDate = tomorrow.toISOString().slice(0, 10);

    const sessions = slots
      .filter(s => s.date === targetDate)
      .sort((a, b) => a.timeStart.localeCompare(b.timeStart));

    if (sessions.length === 0) {
      return res.status(200).json({ sent: 0, message: `Sin sesiones el ${targetDate}` });
    }

    // ── 3. Construir mensajes por persona ─────────────────────────────────────
    const memberMap  = Object.fromEntries(members.map(m => [m.code, m]));
    const dayLabel   = DAYS_ES[tomorrow.getDay()];
    const messages   = [];

    for (const slot of sessions) {
      const assigned = picks.filter(p => p.slotId === slot.id && p.status !== "cancelled");
      for (const pick of assigned) {
        const member = memberMap[pick.memberCode];
        if (!member?.phone) continue;
        const firstName = member.name.split(" ")[0];
        const roleIcon  = member.role === "anfitriona" ? "🎙️" : "💻";
        messages.push({
          phone: member.phone,
          name:  member.name,
          body:
            `¡Hola ${firstName}! 👋\n\n` +
            `Te recordamos tu sesión LIVE de mañana:\n\n` +
            `📅 *${dayLabel} ${targetDate}*\n` +
            `⏰ *${slot.timeStart} – ${slot.timeEnd}*\n` +
            `${roleIcon} Rol: ${member.role}\n\n` +
            `¡Mucho éxito! 🚀 — Equipo BDG`,
        });
      }
    }

    if (messages.length === 0) {
      return res.status(200).json({
        sent: 0,
        message: `${sessions.length} sesión(es) mañana pero ninguna persona tiene teléfono registrado`,
      });
    }

    // ── 4. Dry-run si no hay token ────────────────────────────────────────────
    if (!waToken) {
      return res.status(200).json({
        dry_run: true,
        targetDate,
        sessions: sessions.length,
        messages: messages.map(m => ({ to: `52${m.phone}`, name: m.name, preview: m.body })),
      });
    }

    // ── 5. Enviar vía Meta WhatsApp Cloud API ─────────────────────────────────
    const results = await Promise.allSettled(
      messages.map(({ phone, body }) =>
        fetch(WA_API_BASE, {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${waToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to:   `52${phone}`,
            type: "text",
            text: { body },
          }),
        }).then(r => r.json())
      )
    );

    const sent   = results.filter(r => r.status === "fulfilled" && !r.value.error).length;
    const failed = results.length - sent;
    const errors = results
      .filter(r => r.status === "rejected" || r.value?.error)
      .map(r => r.reason?.message || r.value?.error?.message);

    return res.status(200).json({ sent, failed, targetDate, sessions: sessions.length, errors });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
