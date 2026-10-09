// Funzioni condivise: archivio (Netlify Blobs), menu attuale, PIN, istruzioni del cameriere.
//
// Il menu di partenza è quello scritto dentro index.html. Appena il titolare fa una modifica
// dal pannello, il menu aggiornato viene salvato in Netlify Blobs ("menu/current") e da quel
// momento menu clienti, ordini (prezzi) e cameriere AI leggono tutti da lì.
import { getStore } from "@netlify/blobs";

export const ALLERGENS = ["Glutine", "Crostacei", "Uova", "Pesce", "Arachidi", "Soia", "Latte", "Frutta a guscio", "Sedano", "Senape", "Sesamo", "Solfiti", "Lupini", "Molluschi"];
export const TZ = "Europe/Rome";

export const store = () => getStore({ name: "ristorante", consistency: "strong" });
export const day = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: TZ }); // 2026-09-28

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export function siteOrigin(req) {
  return process.env.URL || new URL(req.url).origin;
}

// ---------- PIN (confronto a tempo costante) ----------
export function checkPin(req, envName) {
  const pin = process.env[envName];
  if (!pin) return null; // non configurato
  const given = req.headers.get("x-pin") || "";
  if (given.length !== pin.length) return false;
  let diff = 0;
  for (let i = 0; i < pin.length; i++) diff |= pin.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
export function pinError(ok, envName) {
  if (ok === null) return json({ error: "Accesso non ancora configurato: contatta l'assistenza" }, 503);
  if (!ok) return json({ error: "PIN errato" }, 401);
  return null;
}

// ---------- ruoli: titolare (ADMIN_PIN), sala (SALA_PIN, facoltativo), cucina (KITCHEN_PIN) ----------
function same(a, b) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function roleOf(req) {
  const given = req.headers.get("x-pin") || "";
  if (!given) return null;
  for (const [env, role] of [["ADMIN_PIN", "titolare"], ["SALA_PIN", "sala"], ["KITCHEN_PIN", "cucina"]]) {
    if (same(process.env[env], given)) return role;
  }
  return null;
}
// null = consentito; altrimenti la risposta di errore da restituire.
// Protezione dai tentativi: dopo 10 PIN sbagliati in 15 minuti dallo stesso indirizzo, blocco di 15 minuti (anche per il PIN giusto).
const ipKey = (req) => (req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0] || "locale").trim().replace(/[^0-9a-fA-F.:]/g, "").slice(0, 45) || "locale";
export async function needRole(req, roles) {
  if (!process.env.ADMIN_PIN) return json({ error: "Accesso non ancora configurato: contatta l'assistenza" }, 503);
  const s = store(), key = `lock/${ipKey(req)}`, now = Date.now();
  let st = null;
  try { st = await s.get(key, { type: "json" }); } catch {}
  if (st?.until > now) return json({ error: "Troppi tentativi con un PIN sbagliato: riprova tra qualche minuto" }, 429);
  const r = roleOf(req);
  if (!r) {
    const fresh = st && now - st.first < 15 * 60000;
    const rec = { fails: (fresh ? st.fails : 0) + 1, first: fresh ? st.first : now };
    if (rec.fails >= 10) rec.until = now + 15 * 60000;
    try { await s.setJSON(key, rec); } catch {}
    return json({ error: rec.until ? "Troppi tentativi con un PIN sbagliato: riprova tra qualche minuto" : "PIN errato" }, rec.until ? 429 : 401);
  }
  if (!roles.includes(r)) return json({ error: "Operazione non consentita con questo accesso" }, 403);
  return null;
}

// ---------- ora di Roma, chiusure straordinarie, pranzo/cena ----------
export function romeMin(now = new Date()) {
  const [h, m] = now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).split(":").map(Number);
  return (h % 24) * 60 + m;
}
export const toMin = (t) => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(t || "").trim()); return m ? +m[1] * 60 + +m[2] : null; };
export function closureOf(R, iso) {
  return (R.closures || []).find((c) => c && c.from && iso >= c.from && iso <= (c.to || c.from)) || null;
}
export function periodOf(R, now = new Date()) {
  return romeMin(now) < (toMin(R.lunch_until) ?? 16 * 60) ? "pranzo" : "cena";
}
// stato di un piatto adesso: "ok" oppure il motivo per cui non si può ordinare
export function itemState(p, R, now = new Date(), sold = {}) {
  if (p.hidden) return "nascosto";
  if (p.av === false) return "non_disponibile";
  if (p.out_until && p.out_until >= day(now)) return "esaurito_oggi";
  if ((p.when === "pranzo" || p.when === "cena") && p.when !== periodOf(R, now)) return p.when === "pranzo" ? "solo_pranzo" : "solo_cena";
  if (Number.isInteger(p.qty) && (sold[p.id] || 0) >= p.qty) return "finito";
  return "ok";
}
export const STATE_TXT = { nascosto: "non è nel menu", non_disponibile: "oggi non è disponibile", esaurito_oggi: "è esaurito per oggi", solo_pranzo: "si serve solo a pranzo", solo_cena: "si serve solo a cena", finito: "è terminato per oggi" };
export async function soldToday(now = new Date()) {
  try { return (await store().get(`sold/${day(now)}`, { type: "json" })) || {}; } catch { return {}; }
}
// menu come lo vedono i clienti (e Marina): piatti nascosti tolti, disponibilità calcolata adesso
export async function publicData(site, now = new Date()) {
  const R = site.data.restaurant;
  const needsSold = site.data.categories.some((c) => c.items.some((p) => Number.isInteger(p.qty)));
  const sold = needsSold ? await soldToday(now) : {};
  const categories = site.data.categories.map((c) => ({
    name: c.name,
    items: c.items.filter((p) => !p.hidden).map((p) => {
      const st = itemState(p, R, now, sold);
      const { out_until, qty, hidden, ...pub } = p;
      const out = { ...pub, av: st === "ok" };
      if (st !== "ok") out.why = st;
      if (Number.isInteger(qty) && st === "ok") out.left = Math.max(0, qty - (sold[p.id] || 0));
      return out;
    }),
  })).filter((c) => c.items.length);
  return { restaurant: R, categories };
}

// ---------- menu di partenza (da index.html) ----------
let base = { at: 0, v: null };
async function loadBase(origin) {
  if (base.v && Date.now() - base.at < 10 * 60 * 1000) return base.v;
  const res = await fetch(origin + "/index.html", { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error("index.html non raggiungibile (" + res.status + ")");
  const html = await res.text();
  const pick = (id) => {
    const m = new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
    if (!m) throw new Error("Blocco " + id + " non trovato in index.html");
    return m[1].replace(/<\\\//g, "</");
  };
  base = { at: Date.now(), v: { data: JSON.parse(pick("menu-data")), rules: pick("marina-rules") } };
  return base.v;
}

// ---------- menu attuale ----------
let cur = { at: 0, v: null };
export async function loadSite(origin, { fresh = false } = {}) {
  if (!fresh && cur.v && Date.now() - cur.at < 10 * 1000) return cur.v;
  const b = await loadBase(origin);
  let saved = null;
  try { saved = await store().get("menu/current", { type: "json" }); } catch (e) { console.error("menu/current", e); }
  let data = saved?.data || b.data;
  // sezioni nuove arrivate con un aggiornamento del sito (es. "Menu del giorno"): si aggiungono al menu salvato dal titolare,
  // senza toccare le sue modifiche. Una sezione che il titolare ha cancellato non torna (è in baseCats).
  if (saved?.data) {
    const known = new Set([...(saved.baseCats || []), ...saved.data.categories.map((c) => c.name)]);
    const ids = new Set(saved.data.categories.flatMap((c) => c.items.map((p) => p.id)));
    const add = b.data.categories.map((c, i) => ({ c, i })).filter(({ c }) => !known.has(c.name));
    if (add.length) {
      const cats = saved.data.categories.slice();
      for (const { c, i } of add) cats.splice(Math.min(i, cats.length), 0, { ...c, items: c.items.filter((p) => !ids.has(p.id)) });
      data = { ...saved.data, categories: cats };
    }
  }
  const byId = {};
  data.categories.forEach((c) => c.items.forEach((p) => (byId[p.id] = { ...p, cat: c.name })));
  cur = { at: Date.now(), v: { data, byId, rules: b.rules, version: saved?.version || 0, updatedAt: saved?.updatedAt || null, contentAt: saved?.contentAt || null } };
  return cur.v;
}

// Salva il menu. baseVersion = versione da cui è partita la modifica (le bozze del pannello).
// keepVersion: cambi di disponibilità immediati (non invalidano le bozze aperte sugli altri dispositivi).
export async function saveMenu(origin, data, baseVersion, { keepVersion = false } = {}) {
  const s = store();
  const cur = await s.getWithMetadata("menu/current", { type: "json" });
  const curVer = cur?.data?.version || 0;
  if (Number(baseVersion) !== curVer) {
    const e = new Error("Il menu è stato modificato da un altro dispositivo: ricarica la pagina");
    e.status = 409;
    throw e;
  }
  const base = await loadBase(origin);
  const now = new Date().toISOString();
  const rec = {
    data, version: keepVersion ? curVer : curVer + 1, rev: (cur?.data?.rev || 0) + 1, updatedAt: now,
    contentAt: keepVersion || (cur && sameContent(cur.data.data, data)) ? cur?.data?.contentAt || null : now,
    baseCats: base.data.categories.map((c) => c.name),
  };
  const w = cur ? await s.setJSON("menu/current", rec, { onlyIfMatch: cur.etag }) : await s.setJSON("menu/current", rec, { onlyIfNew: true });
  if (!w.modified) {
    const e = new Error("Il menu è stato modificato da un altro dispositivo, riprova");
    e.status = 409; e.retry = true;
    throw e;
  }
  cur_reset();
  return rec;
}
function cur_reset() { cur = { at: 0, v: null }; }
// stesso menu (piatti e categorie), a parte la disponibilità del giorno?
function sameContent(a, b) {
  const strip = (d) => JSON.stringify((d?.categories || []).map((c) => [c.name, c.items.map(({ av, out_until, ...p }) => p)]));
  return strip(a) === strip(b);
}

// ---------- prenotazioni: orari prenotabili di un giorno ----------
// quelli dedicati alle prenotazioni (Impostazioni) o, se vuoti, gli orari di apertura meno l'ultimo margine
export function bookable(R, iso, time) {
  if (closureOf(R, iso)) return { ok: false, error: "Quel giorno il locale è chiuso (chiusura straordinaria)" };
  const wd = GIORNI[new Date(iso + "T12:00:00Z").getUTCDay()];
  const own = ((R.booking_hours || []).find((h) => h.day === wd) || {}).hours || "";
  const open = ((R.opening_hours || []).find((h) => h.day === wd) || {}).hours || "";
  const txt = own.trim() || open;
  if (/chius/i.test(txt) || /chius/i.test(open)) return { ok: false, error: "Quel giorno il locale è chiuso" };
  const ranges = rangesOf(txt);
  if (!ranges.length) return { ok: true };
  const t = toMin(time), last = own.trim() ? 0 : R.booking_last_before ?? 60;
  if (ranges.some(([o, c]) => t >= o && t <= c - last)) return { ok: true };
  return { ok: false, error: "Orario non prenotabile: scegli un orario tra quelli proposti" };
}

// ---------- istruzioni del cameriere AI ----------
const euro = (n) => (Math.round(n * 100) / 100).toFixed(2);
// ---------- aperto / chiuso adesso (ora di Roma) ----------
const GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const hm = (t) => String(Math.floor(t / 60) % 24).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
export function rangesOf(hours) {
  if (!hours || /chius/i.test(hours)) return [];
  return [...String(hours).matchAll(/(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/g)].map((m) => { const o = +m[1] * 60 + +m[2]; let c = +m[3] * 60 + +m[4]; if (c <= o) c += 1440; return [o, c]; });
}
export function openStatus(R, now = new Date()) {
  const iso = day(now), wd = new Date(iso + "T12:00:00Z").getUTCDay();
  const [h, m] = now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).split(":").map(Number);
  const nowM = h * 60 + m, hoursOf = (w) => ((R.opening_hours || []).find((x) => x.day === GIORNI[w]) || {}).hours || "";
  const label = new Date(iso + "T12:00:00Z").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const cl = closureOf(R, iso);
  const today = cl ? [] : rangesOf(hoursOf(wd)), cur = today.find(([o, c]) => nowM >= o && nowM < c);
  if (cur) return { open: true, text: `${label}, ore ${hm(nowM)}. Il locale è APERTO adesso (fino alle ${hm(cur[1])}).` };
  if (cl) return { open: false, text: `${label}, ore ${hm(nowM)}. Il locale è CHIUSO per chiusura straordinaria${cl.note ? " (" + cl.note + ")" : ""} fino al ${cl.to || cl.from} compreso.` };
  for (let k = 0; k < 8; k++) {
    const dk = day(new Date(now.getTime() + k * 86400000));
    if (closureOf(R, dk)) continue;
    const w = (wd + k) % 7, r = rangesOf(hoursOf(w)).find(([o]) => k > 0 || o > nowM);
    if (r) {
      const quando = k === 0 ? "oggi" : k === 1 ? "domani" : GIORNI[w].toLowerCase();
      return { open: false, text: `${label}, ore ${hm(nowM)}. Il locale è CHIUSO adesso: riapre ${quando} alle ${hm(r[0])}.` };
    }
  }
  return { open: false, text: `${label}, ore ${hm(nowM)}. Il locale è CHIUSO adesso.` };
}

// data = menu pubblico (publicData): piatti nascosti esclusi, disponibilità già calcolata
export const STATE_SHORT = { non_disponibile: "NON DISPONIBILE oggi", esaurito_oggi: "ESAURITO oggi", solo_pranzo: "NON DISPONIBILE ora (solo a pranzo)", solo_cena: "NON DISPONIBILE ora (solo a cena)", finito: "TERMINATO oggi" };
export function localeText(R, now = new Date()) {
  const oggi = day(now);
  const chiusure = (R.closures || []).filter((c) => (c.to || c.from) >= oggi).map((c) => (c.from === (c.to || c.from) ? c.from : `dal ${c.from} al ${c.to}`) + (c.note ? ` (${c.note})` : ""));
  return `${R.name}${R.tagline ? " – " + R.tagline : ""}. ${R.address}, ${R.postal_code} ${R.city} (${R.province}). Tel ${R.phone}${R.whatsapp ? ", WhatsApp " + R.whatsapp : ""}${R.email ? ", " + R.email : ""}${R.website ? ", " + R.website : ""}.\n` +
    `Orari: ${(R.opening_hours || []).map((h) => `${h.day} ${h.hours}`).join("; ")}. ${R.closing_days || ""}\n` +
    (chiusure.length ? `Chiusure straordinarie: ${chiusure.join("; ")}.\n` : "") +
    `${R.seats ? "Coperti " + R.seats + ", t" : "T"}avoli ${R.tables_count}. Servizi: ${(R.services || []).join("; ") || "-"}.\nInfo: ${R.info || "-"}\n` +
    (R.takeaway_on ? `Asporto: attivo, si ordina in chat. Pronto in almeno ${R.takeaway_min || 20} minuti, si paga al ritiro. Nei giorni di chiusura niente asporto.` : "Asporto: non disponibile.") + "\n" +
    (R.booking_on === false ? "Richieste di prenotazione online: SOSPESE. Per prenotare il cliente deve telefonare." : "Richieste di prenotazione: attive (le conferma sempre il personale).");
}
export function faqText(R) {
  const f = ((R.marina || {}).faq || []).filter((x) => x && x.q && x.a);
  return f.length ? f.map((x) => `D: ${x.q}\nR: ${x.a}`).join("\n") : "(nessuna)";
}
export function buildRules({ data, rules }, table) {
  const R = data.restaurant;
  const menu = data.categories
    .map((c) => `## ${c.name}\n` + c.items
      .map((p) => `${p.id} | ${p.name} | ${euro(p.price)} | ${(p.all || []).join(", ") || "nessuno indicato"} | ${p.veg ? "V" : "-"} | ${p.av ? "disponibile" : STATE_SHORT[p.why] || "NON DISPONIBILE"} | ${p.ingr || "ingredienti non indicati"} | ${p.desc}`)
      .join("\n"))
    .join("\n");
  const modo = table ? `TAVOLO ${table} (il cliente è seduto al tavolo ${table})` : `SITO (${R.takeaway_on ? "asporto" : "asporto non attivo"}; ${R.booking_on === false ? "prenotazioni online sospese" : "richieste di prenotazione"})`;
  return rules.replace("{{LOCALE}}", localeText(R)).replace("{{FAQ}}", faqText(R)).replace("{{ORA}}", openStatus(R).text).replace("{{MODO}}", modo).replace("{{MENU}}", menu);
}

// ---------- storico ordini (condiviso da statistiche e "più ordinati") ----------
export const compact = (o) => ({
  id: o.id, code: o.code, type: o.type || "tavolo", table: o.table, session: o.session || null, pickup: o.pickup || null, createdAt: o.createdAt, status: o.status, total: o.total, note: o.note || "",
  source: o.source || "", cancelReason: o.cancelReason || "", history: o.history || null,
  items: (o.items || []).map((i) => ({ id: i.id, name: i.name, cat: i.cat || "", qty: i.qty, price: i.price, all: i.all || null, note: i.note || "" })),
  prepMin: o.times?.ready ? Math.round((Date.parse(o.times.ready) - Date.parse(o.createdAt)) / 60000) : null,
});

// Gli ordini dei giorni passati vengono riassunti una volta sola in "sum/<data>" per essere veloci
const mem = new Map();
export async function ordersOfDay(s, d, today, yesterday) {
  const closed = d < yesterday;
  if (closed) {
    if (mem.has(d)) return mem.get(d);
    const sum = await s.get(`sum/${d}`, { type: "json" });
    if (sum) { mem.set(d, sum); return sum; }
  }
  const { blobs } = await s.list({ prefix: `o/${d}/` });
  const list = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean).map(compact);
  if (closed) { await s.setJSON(`sum/${d}`, list); mem.set(d, list); }
  return list;
}


// ---------- piatti più ordinati degli ultimi 14 giorni (ricalcolati al massimo ogni 30 minuti) ----------
let topMem = { at: 0, ids: [] };
export async function topSellers() {
  if (Date.now() - topMem.at < 30 * 60 * 1000) return topMem.ids;
  const s = store();
  try {
    const saved = await s.get("top/current", { type: "json" });
    if (saved && Date.now() - saved.at < 30 * 60 * 1000) { topMem = saved; return saved.ids; }
  } catch {}
  const today = day(), yesterday = day(new Date(Date.now() - 86400000)), days = [];
  for (let k = 0; k < 14; k++) days.push(day(new Date(Date.now() - k * 86400000)));
  const qty = {};
  try {
    const lists = await Promise.all(days.map((d) => ordersOfDay(s, d, today, yesterday)));
    for (const o of lists.flat()) if (o.status !== "cancelled") for (const i of o.items || []) qty[i.id] = (qty[i.id] || 0) + i.qty;
  } catch (e) { console.error("top", e); }
  const ids = Object.keys(qty).sort((a, b) => qty[b] - qty[a]).slice(0, 12);
  topMem = { at: Date.now(), ids };
  try { await s.setJSON("top/current", topMem); } catch {}
  return ids;
}
