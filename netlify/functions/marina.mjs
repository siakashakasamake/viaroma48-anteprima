// Cameriere virtuale (AI)
// Riceve la conversazione dal menu e risponde con Claude (Anthropic API).
// Il menu NON è copiato qui: viene letto da index.html (unica fonte dei dati).
//
// Variabili d'ambiente su Netlify:
//   ANTHROPIC_API_KEY  (obbligatoria)
//   CHAT_MODEL         (facoltativa, default: claude-haiku-4-5)
import { buildRules, json, loadSite, publicData, siteOrigin } from "../lib/menu.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "ANTHROPIC_API_KEY non configurata su Netlify" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  // conversazione: solo ruoli validi, testi brevi, ultime 16 battute, inizia e finisce con l'utente
  let turns = (Array.isArray(body.turns) ? body.turns : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
    .slice(-16);
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "Messaggio mancante" }, 400);
  const table = /^\d{1,3}$/.test(String(body.table ?? "")) ? Number(body.table) : null;

  let system;
  try {
    const site = await loadSite(siteOrigin(req));
    system = buildRules({ data: await publicData(site), rules: site.rules }, table);
  } catch (e) {
    return json({ error: "Menu non leggibile: " + e.message }, 500);
  }

  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CHAT_MODEL || "claude-haiku-4-5",
      max_tokens: 500,
      system,
      messages: turns,
    }),
  });
  } catch (e) { return json({ error: "Il servizio AI non risponde" }, 504); }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out?.error?.message || "Errore del servizio AI" }, 502);
  const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return json({ text: text || "Scusa, non ho capito. Puoi ripetere?" });
};

export const config = { path: "/api/marina" };
