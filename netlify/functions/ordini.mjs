// Ordini (al tavolo e da asporto). Salvataggio su Netlify Blobs (nessun database esterno).
//
//   POST  /api/ordini                        il menu invia un ordine                                   (pubblico)
//         con x-pin di titolare o sala e {manuale:true}: ordine inserito dal personale per un tavolo
//   GET   /api/ordini?id=..&t=..             il cliente segue lo stato del suo ordine                  (pubblico, con codice segreto)
//   GET   /api/ordini                        ordini aperti + quelli delle ultime 16 ore                (titolare, sala, cucina)
//   PATCH /api/ordini  {id, status, from?, reason?}   cambio di stato                                  (titolare, sala, cucina)
//
// Stati: new → accepted → preparing → ready → served (servito o ritirato); cancelled con motivazione.
// Ogni ordine conserva nome, prezzo e allergeni dei piatti al momento dell'ordine: cambiare il menu dopo non altera lo storico.
// Gli ordini al tavolo appartengono alla "sessione" aperta di quel tavolo (vedi tavoli.mjs).
import { STATE_TXT, closureOf, day, itemState, json, loadSite, needRole, rangesOf, roleOf, romeMin, siteOrigin, store } from "../lib/menu.mjs";

const STATUSES = ["new", "accepted", "preparing", "ready", "served", "cancelled"];
const NEXT = { new: ["accepted", "preparing", "cancelled"], accepted: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["served", "cancelled"] };
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const keyOf = (id) => {
  const m = /^(\d{4}-\d{2}-\d{2})_[a-z0-9]+$/.exec(String(id || ""));
  return m ? `o/${m[1]}/${id}` : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const WHO = { titolare: "titolare", sala: "sala", cucina: "cucina" };

// Versione pubblica dell'ordine (senza il codice segreto per il cliente)
const publicOrder = ({ token, ...o }) => o;

// Numero progressivo #DS-0001 senza duplicati, anche con ordini simultanei
async function nextNumber(s, orderId) {
  const hint = Number((await s.get("counter", { type: "json" }))?.n) || 0;
  for (let n = hint + 1; n <= hint + 200; n++) {
    const w = await s.setJSON(`num/${String(n).padStart(6, "0")}`, { id: orderId }, { onlyIfNew: true });
    if (w.modified) {
      await s.setJSON("counter", { n });
      return n;
    }
  }
  throw new Error("Numerazione ordini non disponibile, riprova");
}

async function readOrder(s, id) {
  const k = keyOf(id);
  return k ? s.getWithMetadata(k, { type: "json" }) : null;
}

// porzioni vendute oggi per i piatti con quantità limitata ("sold/<giorno>": {id: porzioni})
async function changeSold(s, d, delta, limits) {
  const key = `sold/${d}`;
  for (let i = 0; i < 12; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const sold = { ...(cur?.data || {}) };
    for (const [id, q] of Object.entries(delta)) {
      const next = (sold[id] || 0) + q;
      if (limits && Number.isInteger(limits[id]) && q > 0 && next > limits[id]) {
        const left = Math.max(0, limits[id] - (sold[id] || 0));
        return { ok: false, id, left };
      }
      sold[id] = Math.max(0, next);
    }
    const w = cur ? await s.setJSON(key, sold, { onlyIfMatch: cur.etag }) : await s.setJSON(key, sold, { onlyIfNew: true });
    if (w.modified) return { ok: true };
    await sleep(30);
  }
  throw new Error("Porzioni non aggiornate, riprova");
}

// sessione aperta del tavolo (la apre se non c'è: il primo ordine dal QR "occupa" il tavolo)
async function sessionOf(s, table, by) {
  for (let i = 0; i < 6; i++) {
    const cur = await s.get(`tav/${table}`, { type: "json" });
    if (cur?.sid) return cur.sid;
    const now = new Date();
    const rec = { sid: `${day(now)}_${now.getTime().toString(36)}${rand(2)}`, table, openedAt: now.toISOString(), covers: null, by, note: "" };
    const w = await s.setJSON(`tav/${table}`, rec, { onlyIfNew: true });
    if (w.modified) return rec.sid;
  }
  return null;
}

// ---------------------------------------------------------------- POST: nuovo ordine
async function createOrder(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }

  let role = null;
  if (body.manuale === true) { const bad = await needRole(req, ["titolare", "sala"]); if (bad) return bad; role = roleOf(req); }
  const staff = body.manuale === true;

  let site;
  try { site = await loadSite(siteOrigin(req), { fresh: true }); } catch (e) { return json({ error: "Menu non leggibile, riprova tra poco" }, 500); }
  const R = site.data.restaurant;
  const now = new Date(), today = day(now);

  const asporto = body.type === "asporto" && !staff;
  let table = null, pickup = null;
  if (asporto) {
    if (!R.takeaway_on) return json({ error: "Al momento l'asporto non è attivo" }, 400);
    const oggi = now.toLocaleDateString("it-IT", { weekday: "long", timeZone: "Europe/Rome" }).toLowerCase();
    const orario = (R.opening_hours || []).find((h) => String(h.day).toLowerCase() === oggi);
    if (closureOf(R, today) || (orario && /chius/i.test(orario.hours))) return json({ error: "Oggi il locale è chiuso: l'asporto non è disponibile, puoi prenotare un tavolo" }, 400);
    if (orario) {
      const nowM = romeMin(now), OB = R.takeaway_open_before ?? 30, CB = R.takeaway_close_before ?? 30;
      const [ph, pm] = String(body.time || "").split(":").map(Number), pick = ph * 60 + pm;
      const ranges = rangesOf(orario.hours);
      const ok = !ranges.length || ranges.some(([o, c]) => nowM >= o - OB && nowM <= c - CB && pick >= o && pick <= c - CB && pick >= nowM);
      if (!ok) return json({ error: "Orario di ritiro non disponibile: gli ordini da asporto si aprono mezz'ora prima dell'apertura e chiudono mezz'ora prima della chiusura" }, 400);
    }
    const name = clean(body.name, 60), phone = String(body.phone || "").replace(/[^\d+ ]/g, "").trim().slice(0, 20), time = String(body.time || "");
    if (name.length < 2) return json({ error: "Scrivi il tuo nome per il ritiro" }, 400);
    // telefono facoltativo se il cliente manda il riepilogo anche su WhatsApp (il numero lo vede il ristorante in chat)
    if (body.via !== "whatsapp" && phone.replace(/\D/g, "").length < 6) return json({ error: "Numero di telefono non valido" }, 400);
    if (phone && phone.replace(/\D/g, "").length < 6) return json({ error: "Numero di telefono non valido" }, 400);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json({ error: "Orario di ritiro non valido" }, 400);
    pickup = { name, phone, time, via: body.via === "whatsapp" ? "whatsapp" : "sito" };
  } else {
    table = Number(body.table);
    if (!Number.isInteger(table) || table < 1 || table > (R.tables_count || 20)) return json({ error: "Numero del tavolo non valido" }, 400);
  }

  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) return json({ error: "Il carrello è vuoto" }, 400);
  if (raw.length > 40) return json({ error: "Troppe righe nell'ordine" }, 400);

  const needsSold = raw.some((it) => Number.isInteger(site.byId[String(it?.id || "")]?.qty));
  let sold = {};
  if (needsSold) sold = (await store().get(`sold/${today}`, { type: "json" })) || {};
  const items = [], want = {}, limits = {};
  for (const it of raw) {
    const p = site.byId[String(it?.id || "")];
    const q = Number(it?.q);
    if (!p || p.hidden) return json({ error: "Un prodotto non è più nel menu: aggiorna la pagina" }, 400);
    const st = itemState(p, R, now, sold);
    if (st !== "ok") return json({ error: `"${p.name}" ${STATE_TXT[st] || "non è disponibile"}` }, 409);
    if (!Number.isInteger(q) || q < 1 || q > 20) return json({ error: "Quantità non valida" }, 400);
    // nome, prezzo e allergeni SEMPRE dal menu, copiati nell'ordine
    items.push({ id: p.id, name: p.name, cat: p.cat, qty: q, price: p.price, all: (p.all || []).slice(), note: clean(it.nota, 200) });
    if (Number.isInteger(p.qty)) { want[p.id] = (want[p.id] || 0) + q; limits[p.id] = p.qty; }
  }
  const total = Math.round(items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;
  const ref = /^[a-z0-9-]{16,64}$/i.test(String(body.ref || "")) ? String(body.ref) : null;

  const s = store();

  // stesso carrello inviato due volte (doppio tocco, rete lenta): restituisce l'ordine già creato
  const fromRef = async () => {
    for (let i = 0; i < 10; i++) {
      const r = await s.get(`ref/${ref}`, { type: "json" });
      if (r?.id) {
        const o = await readOrder(s, r.id);
        if (o?.data) return json({ ...publicOrder(o.data), token: o.data.token, duplicate: true });
      }
      await sleep(150);
    }
    return json({ error: "Ordine in elaborazione, riprova tra un attimo" }, 409);
  };
  if (ref && (await s.get(`ref/${ref}`, { type: "json" }))) return fromRef();

  const id = `${today}_${now.getTime().toString(36)}${rand(3)}`;
  if (ref) {
    const w = await s.setJSON(`ref/${ref}`, { id }, { onlyIfNew: true });
    if (!w.modified) return fromRef();
  }

  // porzioni limitate: le riserva in modo atomico
  if (Object.keys(want).length) {
    const r = await changeSold(s, today, want, limits);
    if (!r.ok) {
      if (ref) await s.delete(`ref/${ref}`);
      const p = site.byId[r.id];
      return json({ error: r.left ? `Di "${p.name}" restano solo ${r.left} porzioni` : `"${p.name}" è terminato per oggi` }, 409);
    }
  }

  let n;
  try { n = await nextNumber(s, id); }
  catch (e) { if (Object.keys(want).length) await changeSold(s, today, Object.fromEntries(Object.entries(want).map(([k, v]) => [k, -v]))); return json({ error: e.message }, 503); }

  const by = staff ? WHO[role] : "cliente";
  const session = table ? await sessionOf(s, table, staff ? WHO[role] : "qr") : null;
  const order = {
    id,
    code: `${R.order_prefix || "ORD"}-${String(n).padStart(4, "0")}`,
    number: n,
    type: asporto ? "asporto" : "tavolo",
    table,
    session,
    pickup,
    items,
    note: clean(body.note, 300),
    total,
    status: "new",
    source: staff ? "personale" : asporto ? (pickup.via === "whatsapp" ? "chat + WhatsApp" : "menu") : "QR del tavolo",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: [{ s: "new", at: now.toISOString(), by }],
    token: rand(12),
  };
  await s.setJSON(keyOf(id), order);
  return json({ ...publicOrder(order), token: order.token }, 201);
}

// ---------------------------------------------------------------- GET personale: ordini aperti e recenti
const listCache = new Map(); // key -> {etag, data}
async function listOrders() {
  const s = store();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const blobs = [];
  for (const d of [day(yesterday), day(today)]) {
    const { blobs: b } = await s.list({ prefix: `o/${d}/` });
    blobs.push(...b);
  }
  const out = await Promise.all(
    blobs.map(async ({ key, etag }) => {
      const c = listCache.get(key);
      if (c && etag && c.etag === etag) return c.data;
      const data = await s.get(key, { type: "json" });
      if (data && etag) listCache.set(key, { etag, data });
      return data;
    }),
  );
  const cutoff = Date.now() - 16 * 3600000;
  return out
    .filter(Boolean)
    .filter((o) => ["new", "accepted", "preparing", "ready"].includes(o.status) || Date.parse(o.createdAt) > cutoff)
    .map(publicOrder)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------- PATCH: cambio stato
async function updateStatus(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const to = String(body.status || "");
  if (!STATUSES.includes(to)) return json({ error: "Stato non valido" }, 400);
  const reason = clean(body.reason, 160);
  if (to === "cancelled" && reason.length < 3) return json({ error: "Scrivi il motivo dell'annullamento" }, 400);
  const by = WHO[roleOf(req)] || "personale";
  const s = store();
  const k = keyOf(body.id);
  if (!k) return json({ error: "Ordine non trovato" }, 404);
  for (let i = 0; i < 8; i++) {
    const cur = await s.getWithMetadata(k, { type: "json" });
    if (!cur) return json({ error: "Ordine non trovato" }, 404);
    const o = cur.data;
    if (o.status === to) return json({ ...publicOrder(o), unchanged: true });
    // un altro dispositivo ha già cambiato lo stato: non si salta un passaggio per errore
    if (body.from && body.from !== o.status) return json({ error: `L'ordine è già "${o.status}" (cambiato da un altro dispositivo)`, order: publicOrder(o) }, 409);
    if (!(NEXT[o.status] || []).includes(to)) return json({ error: `Passaggio non consentito: ${o.status} → ${to}` }, 409);
    const at = new Date().toISOString();
    const h = { s: to, at, by };
    if (to === "cancelled") h.reason = reason;
    const upd = { ...o, status: to, updatedAt: at, times: { ...(o.times || {}), [to]: at }, history: [...(o.history || [{ s: "new", at: o.createdAt, by: "cliente" }]), h] };
    if (to === "cancelled") upd.cancelReason = reason;
    const w = await s.setJSON(k, upd, { onlyIfMatch: cur.etag });
    if (w.modified) {
      // annullato: le porzioni limitate tornano disponibili
      if (to === "cancelled") {
        const site = await loadSite(siteOrigin(req)).catch(() => null);
        const back = {};
        for (const it of o.items || []) if (Number.isInteger(site?.byId[it.id]?.qty)) back[it.id] = (back[it.id] || 0) - it.qty;
        if (Object.keys(back).length) await changeSold(s, o.createdAt ? day(new Date(o.createdAt)) : day(), back).catch(() => {});
      }
      return json(publicOrder(upd));
    }
    await sleep(50);
  }
  return json({ error: "Ordine modificato da un altro dispositivo, riprova" }, 409);
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "POST") return await createOrder(req);

    if (req.method === "GET" && url.searchParams.get("id")) {
      // il cliente segue il proprio ordine
      const o = await readOrder(store(), url.searchParams.get("id"));
      if (!o?.data || o.data.token !== url.searchParams.get("t")) return json({ error: "Ordine non trovato" }, 404);
      return json(publicOrder(o.data));
    }

    const bad = await needRole(req, ["titolare", "sala", "cucina"]);
    if (bad) return bad;

    if (req.method === "GET") return json({ orders: await listOrders(), now: new Date().toISOString(), role: roleOf(req) });
    if (req.method === "PATCH") return await updateStatus(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server, riprova" }, 500);
  }
};

export const config = { path: "/api/ordini" };
