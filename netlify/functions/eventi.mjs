// Statistiche delle visite al menu (anonime: nessun dato personale, nessun cookie di terze parti)
//   POST /api/eventi                 il menu invia il riepilogo della visita (sendBeacon)          (pubblico)
//   GET  /api/eventi?dal=..&al=..    il titolare legge le statistiche delle visite                 (ADMIN_PIN)
// Ogni visita è salvata come "ev/<data>/<id visita>" (riscritta finché la visita continua).
// I giorni chiusi vengono riassunti una volta sola in "evsum/<data>".
import { day, json, needRole, store } from "../lib/menu.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9]{8,32}$/;
const EVENTS = ["chiama", "prenota", "prenota_whatsapp", "info", "marina", "marina_msg", "indicazioni", "recensione_google",
  "carrello", "riepilogo", "ordine", "ordine_asporto", "stato_ordine", "voto", "sezioni_home", "wa_ordine", "riepilogo_chat", "prenota_riepilogo"];
// domande a cui Marina non ha saputo rispondere: tolti numeri lunghi ed email (niente dati personali)
const anon = (t) => str(t, 160).replace(/\S+@\S+/g, "[email]").replace(/(\+?\d[\d\s.-]{5,}\d)/g, "[numero]");
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

function cleanMap(m, keyRe, maxKeys, maxVal, keyLen = 40) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const [k, v] of Object.entries(m).slice(0, maxKeys)) {
    const kk = str(k, keyLen);
    if (kk && keyRe.test(kk)) out[kk] = num(v, maxVal);
  }
  return out;
}

async function save(req) {
  let b;
  try { b = JSON.parse(await req.text()); } catch { return new Response(null, { status: 204 }); }
  if (!b || !ID_RE.test(String(b.sid)) || !ID_RE.test(String(b.vid))) return new Response(null, { status: 204 });
  const start = Number(b.start);
  if (!Number.isFinite(start) || Math.abs(Date.now() - start) > 2 * 86400000) return new Response(null, { status: 204 });
  const d = day(new Date(start));
  const rec = {
    sid: b.sid, vid: b.vid, start: new Date(start).toISOString(),
    src: b.src === "qr" ? "qr" : "sito", dev: b.dev === "desktop" ? "desktop" : "mobile",
    dur: num(b.dur, 4 * 3600),
    ev: cleanMap(b.ev, new RegExp("^(" + EVENTS.join("|") + ")$"), 30, 500),
    sec: cleanMap(b.sec, /^[^<>]{1,40}$/, 40, 500),
    secTime: cleanMap(b.secTime, /^[^<>]{1,40}$/, 40, 4 * 3600),
    dishOpen: cleanMap(b.dishOpen, /^[A-Z]{1,2}\d{2,3}$/, 120, 200, 8),
    dishAdd: cleanMap(b.dishAdd, /^[A-Z]{1,2}\d{2,3}$/, 120, 200, 8),
    mq: cleanMap(b.mq, /^(Messaggio|Pulsante): [^<>]{1,40}$/, 60, 500, 52),
  };
  await store().setJSON(`ev/${d}/${rec.sid}`, rec);
  const nr = (Array.isArray(b.nr) ? b.nr : []).slice(0, 8).map((x) => ({ q: anon(x?.q), at: Number(x?.at) || start, via: x?.via === "ai" ? "ai" : "auto" })).filter((x) => x.q.length >= 3);
  if (nr.length) await store().setJSON(`nr/${d}/${rec.sid}`, { src: rec.src, list: nr });
  return new Response(null, { status: 204 });
}

const add = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };
const hourOf = (iso) => Number(new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hour12: false })) % 24;

function summarize(list) {
  const s = { sessions: 0, vids: [], dur: 0, durN: 0, src: { qr: 0, sito: 0 }, dev: { mobile: 0, desktop: 0 }, ev: {}, sec: {}, secTime: {}, dishOpen: {}, dishAdd: {}, mq: {},
    byHour: Array(24).fill(0), withCart: 0, withReview: 0, withOrder: 0, bounce: 0 };
  const seen = new Set();
  for (const r of list) {
    s.sessions++;
    if (!seen.has(r.vid)) { seen.add(r.vid); s.vids.push(r.vid); }
    if (r.dur > 0) { s.dur += r.dur; s.durN++; }
    s.src[r.src]++; s.dev[r.dev]++;
    add(s.ev, r.ev); add(s.sec, r.sec); add(s.secTime, r.secTime); add(s.dishOpen, r.dishOpen); add(s.dishAdd, r.dishAdd); add(s.mq, r.mq);
    s.byHour[hourOf(r.start)]++;
    const added = Object.values(r.dishAdd || {}).reduce((t, v) => t + v, 0) > 0;
    const ordered = (r.ev.ordine || 0) + (r.ev.ordine_asporto || 0) > 0;
    if (added || ordered) s.withCart++;
    if (r.ev.riepilogo || ordered) s.withReview++;
    if (ordered) s.withOrder++;
    if (r.dur < 10 && !Object.keys(r.sec || {}).length && !added) s.bounce++;
  }
  return s;
}

const mem = new Map();
async function dayStats(s, d, yesterday) {
  const closed = d < yesterday;
  if (closed) {
    if (mem.has(d)) return mem.get(d);
    const saved = await s.get(`evsum/${d}`, { type: "json" });
    if (saved) { mem.set(d, saved); return saved; }
  }
  const { blobs } = await s.list({ prefix: `ev/${d}/` });
  const list = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
  const sum = { date: d, ...summarize(list) };
  if (closed) { await s.setJSON(`evsum/${d}`, sum); mem.set(d, sum); }
  return sum;
}

async function unanswered(s, days) {
  const out = [];
  for (const d of days) {
    const { blobs } = await s.list({ prefix: `nr/${d}/` });
    const list = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
    for (const r of list) for (const x of r.list || []) out.push({ q: x.q, at: new Date(x.at).toISOString(), via: x.via, src: r.src });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
}

async function read(req) {
  const bad = await needRole(req, ["titolare"]);
  if (bad) return bad;
  const u = new URL(req.url), today = day(), yesterday = day(new Date(Date.now() - 86400000));
  const dal = DAY_RE.test(u.searchParams.get("dal") || "") ? u.searchParams.get("dal") : today;
  const al = DAY_RE.test(u.searchParams.get("al") || "") ? u.searchParams.get("al") : today;
  const days = [], d = new Date(dal + "T12:00:00Z"), end = new Date((al < today ? al : today) + "T12:00:00Z");
  while (d <= end && days.length < 92) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const s = store();
  if (u.searchParams.get("nr")) return json({ dal, al, items: await unanswered(s, days) });
  const per = await Promise.all(days.map((x) => dayStats(s, x, yesterday)));
  const t = { sessions: 0, dur: 0, durN: 0, src: { qr: 0, sito: 0 }, dev: { mobile: 0, desktop: 0 }, ev: {}, sec: {}, secTime: {}, dishOpen: {}, dishAdd: {}, mq: {},
    byHour: Array(24).fill(0), withCart: 0, withReview: 0, withOrder: 0, bounce: 0 };
  const vids = new Set();
  for (const p of per) {
    t.sessions += p.sessions; t.dur += p.dur; t.durN += p.durN; t.withCart += p.withCart; t.withReview += p.withReview; t.withOrder += p.withOrder; t.bounce += p.bounce;
    add(t.src, p.src); add(t.dev, p.dev); add(t.ev, p.ev); add(t.sec, p.sec); add(t.secTime, p.secTime); add(t.dishOpen, p.dishOpen); add(t.dishAdd, p.dishAdd); add(t.mq, p.mq || {});
    p.byHour.forEach((v, i) => (t.byHour[i] += v));
    p.vids.forEach((v) => vids.add(v));
  }
  return json({
    dal, al, sessions: t.sessions, visitors: vids.size, avgDur: t.durN ? Math.round(t.dur / t.durN) : 0,
    src: t.src, dev: t.dev, ev: t.ev, sec: t.sec, secTime: t.secTime, dishOpen: t.dishOpen, dishAdd: t.dishAdd, mq: t.mq, byHour: t.byHour,
    funnel: { visite: t.sessions, carrello: t.withCart, riepilogo: t.withReview, ordine: t.withOrder }, bounce: t.bounce,
    byDay: per.map((p) => ({ date: p.date, sessions: p.sessions, visitors: p.vids.length })),
  });
}

export default async (req) => {
  try {
    if (req.method === "POST") return await save(req);
    if (req.method === "GET") return await read(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return req.method === "POST" ? new Response(null, { status: 204 }) : json({ error: "Errore del server" }, 500);
  }
};

export const config = { path: "/api/eventi" };
