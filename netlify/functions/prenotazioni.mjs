// Richieste di prenotazione dei tavoli
//   POST  /api/prenotazioni  {day, time, ppl, name, phone, note, ref}   il cliente invia una RICHIESTA con Marina     (pubblico)
//         con x-pin di titolare o sala: prenotazione inserita dal personale (telefono, di persona): è già confermata
//   GET   /api/prenotazioni?dal=..&al=..                                  elenco                                       (titolare, sala)
//   GET   /api/prenotazioni?conta=1                                       richieste da confermare, da oggi in avanti   (titolare, sala)
//   PATCH /api/prenotazioni  {id, status, from?, reason?}                 cambio di stato                              (titolare, sala)
// Una richiesta ricevuta NON è una conferma: conferma sempre il personale, esplicitamente.
// Salvate in Netlify Blobs come "pren/<giorno>/<id>".
import { bookable, day, json, loadSite, needRole, roleOf, siteOrigin, store, toMin } from "../lib/menu.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// nuova = richiesta ricevuta · arrivata = completata · noshow = cliente non presentato
const STATI = ["nuova", "confermata", "rifiutata", "annullata", "arrivata", "noshow"];
const ATTIVE = ["nuova", "confermata", "arrivata"];
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function dayList(s, d) {
  const { blobs } = await s.list({ prefix: `pren/${d}/` });
  return (await Promise.all(blobs.map((bl) => s.get(bl.key, { type: "json" })))).filter(Boolean);
}

async function create(req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  // con un PIN: inserita dal personale (il PIN deve essere giusto, con lo stesso blocco dei tentativi)
  if (req.headers.get("x-pin")) { const bad = await needRole(req, ["titolare", "sala"]); if (bad) return bad; }
  const role = roleOf(req), staff = role === "titolare" || role === "sala";
  const d = String(b.day || ""), t = String(b.time || ""), ppl = Number(b.ppl);
  const name = clean(b.name, 60), phone = clean(b.phone, 25).replace(/[^\d+ ]/g, "").trim(), note = clean(b.note, 200);
  if (!DAY_RE.test(d) || isNaN(Date.parse(d))) return json({ error: "Data non valida" }, 400);
  if (!TIME_RE.test(t)) return json({ error: "Orario non valido" }, 400);
  if (!Number.isInteger(ppl) || ppl < 1 || ppl > 99) return json({ error: "Numero di persone non valido" }, 400);
  if (name.length < 2) return json({ error: "Scrivi il nome per la prenotazione" }, 400);
  if (!staff && phone.replace(/\D/g, "").length < 6) return json({ error: "Numero di telefono non valido" }, 400);
  const today = day();
  if (d < today) return json({ error: "La data è già passata" }, 400);
  if (d > day(new Date(Date.now() + 180 * 86400000))) return json({ error: "Si può prenotare al massimo 6 mesi prima" }, 400);
  let site;
  try { site = await loadSite(siteOrigin(req), { fresh: true }); } catch (e) { return json({ error: "Servizio non disponibile, riprova tra poco" }, 500); }
  const R = site.data.restaurant;
  if (!staff) {
    if (R.booking_on === false) return json({ error: "Le prenotazioni online sono sospese: chiama il locale" }, 400);
    const v = bookable(R, d, t);
    if (!v.ok) return json({ error: v.error }, 400);
  }
  const s = store();
  const ref = /^[a-z0-9]{6,40}$/.test(String(b.ref || "")) ? b.ref : null;
  if (ref) {
    const old = await s.get(`pref/${ref}`, { type: "json" });
    if (old) return json({ ok: true, id: old.id, dup: true }, 200);
  }
  const id = `${d}_${rid()}`;
  if (ref) {
    const w = await s.setJSON(`pref/${ref}`, { id }, { onlyIfNew: true });
    if (!w.modified) return json({ ok: true, id: (await s.get(`pref/${ref}`, { type: "json" })).id, dup: true }, 200);
  }
  // segnalazioni per il personale (non bloccano la richiesta: decide chi conferma)
  const same = (await dayList(s, d)).filter((x) => ATTIVE.includes(x.status));
  const flags = [];
  const digits = phone.replace(/\D/g, "");
  if (digits && same.some((x) => String(x.phone || "").replace(/\D/g, "") === digits)) flags.push("stesso telefono già prenotato quel giorno");
  const cap = R.booking_capacity || 0;
  if (cap) {
    const slot = Math.floor(toMin(t) / 30);
    const inSlot = same.filter((x) => Math.floor(toMin(x.time) / 30) === slot).reduce((n, x) => n + x.ppl, 0);
    if (inSlot + ppl > cap) flags.push(`fascia oltre la capacità (${inSlot + ppl} coperti su ${cap})`);
  }
  const now = new Date().toISOString();
  const status = staff ? "confermata" : "nuova";
  const rec = {
    id, day: d, time: t, ppl, name, phone, note, status, src: staff ? "pannello" : "marina", flags, createdAt: now,
    history: [{ s: status, at: now, by: staff ? role : "cliente" }],
  };
  await s.setJSON(`pren/${d}/${id}`, rec);
  return json({ ok: true, id, status, flags }, 201);
}

async function list(req) {
  const u = new URL(req.url), today = day();
  const s = store();
  if (u.searchParams.get("conta")) {
    const { blobs } = await s.list({ prefix: "pren/" });
    const keys = blobs.map((x) => x.key).filter((k) => k.slice(5, 15) >= today);
    const recs = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
    return json({
      nuove: recs.filter((r) => r.status === "nuova").length,
      oggi: recs.filter((r) => r.day === today && ["nuova", "confermata"].includes(r.status)).length,
      copertiOggi: recs.filter((r) => r.day === today && ["nuova", "confermata"].includes(r.status)).reduce((n, r) => n + r.ppl, 0),
    });
  }
  const dal = DAY_RE.test(u.searchParams.get("dal") || "") ? u.searchParams.get("dal") : today;
  const al = DAY_RE.test(u.searchParams.get("al") || "") ? u.searchParams.get("al") : dal;
  const days = [], d = new Date(dal + "T12:00:00Z"), end = new Date(al + "T12:00:00Z");
  while (d <= end && days.length < 186) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const lists = await Promise.all(days.map((x) => dayList(s, x)));
  const items = lists.flat().sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time) || a.createdAt.localeCompare(b.createdAt));
  return json({ dal, al, items: items.slice(0, 1000) });
}

async function update(req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const m = /^(\d{4}-\d{2}-\d{2})_[a-z0-9]+$/.exec(String(b.id || ""));
  if (!m) return json({ error: "Prenotazione non valida" }, 400);
  if (!STATI.includes(b.status)) return json({ error: "Stato non valido" }, 400);
  const s = store(), key = `pren/${m[1]}/${b.id}`;
  for (let i = 0; i < 6; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    if (!cur?.data) return json({ error: "Prenotazione non trovata" }, 404);
    const r = cur.data;
    if (r.status === b.status) return json({ ok: true, item: r, unchanged: true });
    if (b.from && b.from !== r.status) return json({ error: "La prenotazione è già stata aggiornata da un altro dispositivo", item: r }, 409);
    const at = new Date().toISOString(), h = { s: b.status, at, by: roleOf(req) };
    const reason = clean(b.reason, 160);
    if (reason) h.reason = reason;
    const upd = { ...r, status: b.status, updatedAt: at, history: [...(r.history || [{ s: "nuova", at: r.createdAt, by: r.src === "pannello" ? "titolare" : "cliente" }]), h] };
    const w = await s.setJSON(key, upd, { onlyIfMatch: cur.etag });
    if (w.modified) return json({ ok: true, item: upd });
  }
  return json({ error: "Modificata da un altro dispositivo, riprova" }, 409);
}

export default async (req) => {
  try {
    if (req.method === "POST") return await create(req);
    const bad = await needRole(req, ["titolare", "sala"]);
    if (bad) return bad;
    if (req.method === "GET") return await list(req);
    if (req.method === "PATCH") return await update(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server, riprova" }, 500);
  }
};

export const config = { path: "/api/prenotazioni" };
