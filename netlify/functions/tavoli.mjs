// Sessioni dei tavoli: lo stato del tavolo è separato dallo stato delle comande.
//   GET  /api/tavoli                                   tavoli con la sessione aperta            (titolare, sala)
//   GET  /api/tavoli?storico=1&dal=..&al=..            sessioni chiuse (storico)                (titolare, sala)
//   POST /api/tavoli {azione:"apri", table, covers, note}            apre il tavolo              (titolare, sala)
//   POST /api/tavoli {azione:"modifica", table, sid, covers, note}   coperti / nota              (titolare, sala)
//   POST /api/tavoli {azione:"chiudi", table, sid, forza}            libera il tavolo            (titolare, sala)
// Sessione aperta: "tav/<tavolo>". Alla chiusura viene archiviata in "tsess/<giorno>/<sid>" con le sue comande:
// lo storico resta, e il cliente successivo apre una sessione nuova (le comande non si mescolano).
import { day, json, loadSite, needRole, roleOf, siteOrigin, store } from "../lib/menu.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN = ["new", "accepted", "preparing", "ready"];
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const covers = (v) => { if (v === null || v === undefined || v === "") return null; const n = parseInt(v, 10); return Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined; };

async function ordersOfSession(s, sid, openedAt) {
  const days = new Set([day(new Date(openedAt)), day(new Date(Date.now() - 86400000)), day()]);
  const out = [];
  for (const d of days) {
    const { blobs } = await s.list({ prefix: `o/${d}/` });
    const list = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
    for (const o of list) if (o && o.session === sid) out.push(o);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function list(req) {
  const u = new URL(req.url), s = store();
  if (u.searchParams.get("storico")) {
    const today = day();
    const dal = DAY_RE.test(u.searchParams.get("dal") || "") ? u.searchParams.get("dal") : today;
    const al = DAY_RE.test(u.searchParams.get("al") || "") ? u.searchParams.get("al") : today;
    const days = [], d = new Date(dal + "T12:00:00Z"), end = new Date(al + "T12:00:00Z");
    while (d <= end && days.length < 92) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    const lists = await Promise.all(days.map(async (x) => {
      const { blobs } = await s.list({ prefix: `tsess/${x}/` });
      return (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
    }));
    const items = lists.flat().sort((a, b) => b.closedAt.localeCompare(a.closedAt));
    return json({ dal, al, sessions: items.slice(0, 500) });
  }
  const site = await loadSite(siteOrigin(req));
  const n = site.data.restaurant.tables_count || 20;
  const { blobs } = await s.list({ prefix: "tav/" });
  const open = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter((x) => x && x.table <= n);
  return json({ tables: n, sessions: open, now: new Date().toISOString(), role: roleOf(req) });
}

async function act(req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const site = await loadSite(siteOrigin(req));
  const table = Number(b.table);
  if (!Number.isInteger(table) || table < 1 || table > (site.data.restaurant.tables_count || 20)) return json({ error: "Numero del tavolo non valido" }, 400);
  const s = store(), key = `tav/${table}`, by = roleOf(req);
  const cv = covers(b.covers);
  if (cv === undefined) return json({ error: "Numero di coperti non valido (da 1 a 99)" }, 400);

  if (b.azione === "apri") {
    const now = new Date();
    const rec = { sid: `${day(now)}_${now.getTime().toString(36)}${rand(2)}`, table, openedAt: now.toISOString(), covers: cv, by, note: clean(b.note, 120) };
    const w = await s.setJSON(key, rec, { onlyIfNew: true });
    if (!w.modified) return json({ error: `Il tavolo ${table} è già aperto`, session: await s.get(key, { type: "json" }) }, 409);
    return json({ ok: true, session: rec }, 201);
  }

  const cur = await s.getWithMetadata(key, { type: "json" });
  if (!cur?.data) return json({ error: `Il tavolo ${table} è già libero` }, 409);
  if (b.sid && b.sid !== cur.data.sid) return json({ error: "Il tavolo è stato chiuso e riaperto da un altro dispositivo: aggiorna la pagina" }, 409);

  if (b.azione === "modifica") {
    const upd = { ...cur.data, covers: cv, note: b.note === undefined ? cur.data.note : clean(b.note, 120) };
    const w = await s.setJSON(key, upd, { onlyIfMatch: cur.etag });
    if (!w.modified) return json({ error: "Modificato da un altro dispositivo, riprova" }, 409);
    return json({ ok: true, session: upd });
  }

  if (b.azione === "chiudi") {
    const orders = await ordersOfSession(s, cur.data.sid, cur.data.openedAt);
    const open = orders.filter((o) => OPEN.includes(o.status));
    if (open.length && !b.forza) return json({ error: `Ci sono ancora ${open.length} comande non servite`, open: open.map((o) => o.code) }, 409);
    const valid = orders.filter((o) => o.status !== "cancelled");
    const closedAt = new Date().toISOString();
    const rec = {
      ...cur.data, closedAt, closedBy: by,
      total: Math.round(valid.reduce((t, o) => t + o.total, 0) * 100) / 100,
      orders: orders.map((o) => ({ id: o.id, code: o.code, status: o.status, total: o.total, createdAt: o.createdAt, items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })) })),
    };
    await s.setJSON(`tsess/${day(new Date(cur.data.openedAt))}/${cur.data.sid}`, rec);
    // si libera solo se nel frattempo nessuno ha toccato la sessione
    const again = await s.getWithMetadata(key, { type: "json" });
    if (again?.data?.sid === cur.data.sid) await s.delete(key);
    return json({ ok: true, session: rec });
  }
  return json({ error: "Azione non valida" }, 400);
}

export default async (req) => {
  try {
    const bad = await needRole(req, ["titolare", "sala"]);
    if (bad) return bad;
    if (req.method === "GET") return await list(req);
    if (req.method === "POST") return await act(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server, riprova" }, 500);
  }
};

export const config = { path: "/api/tavoli" };
