// Menu attuale del ristorante
//   GET   /api/menu             menu come lo vedono i clienti: piatti nascosti esclusi, disponibilità calcolata adesso (pubblico)
//   GET   /api/menu?tutto=1     menu completo con piatti nascosti, quantità e porzioni vendute oggi   (titolare o sala)
//   PUT   /api/menu             il titolare pubblica le modifiche   body: { data, baseVersion }        (titolare)
//   PATCH /api/menu             disponibilità immediata di un piatto, senza toccare le bozze          (titolare o sala)
//                               body: { id, azione: "esaurito_oggi" | "disponibile" | "non_disponibile" }
import { ALLERGENS, day, json, loadSite, needRole, publicData, saveMenu, siteOrigin, soldToday, store, topSellers } from "../lib/menu.mjs";

const str = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const int = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };

// WhatsApp: solo cifre con prefisso internazionale (+39…). Vuoto = si usa il telefono.
function cleanWa(v) {
  const s = str(v, 30);
  if (!s) return "";
  const d = s.replace(/[^\d+]/g, "");
  if (!/^\+\d{8,15}$/.test(d)) throw new Error("Numero WhatsApp non valido: scrivilo con il prefisso internazionale, per esempio +39 333 1234567");
  return s;
}

// Controlla e ripulisce tutto ciò che arriva dal pannello
function validate(input) {
  const R = input?.restaurant, cats = input?.categories;
  if (!R || typeof R !== "object") throw new Error("Dati del locale mancanti");
  if (!Array.isArray(cats) || !cats.length || cats.length > 20) throw new Error("Categorie non valide");
  const days7 = (a) => (Array.isArray(a) ? a : []).slice(0, 7).map((h) => ({ day: str(h?.day, 20), hours: str(h?.hours, 60) }));
  const closures = (Array.isArray(R.closures) ? R.closures : []).slice(0, 40).map((c) => {
    const from = String(c?.from || ""), to = String(c?.to || c?.from || "");
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new Error("Data di chiusura non valida");
    return { from: from <= to ? from : to, to: from <= to ? to : from, note: str(c?.note, 80) };
  });
  const faq = (Array.isArray(R.marina?.faq) ? R.marina.faq : []).slice(0, 60)
    .map((f) => ({ q: str(f?.q, 160), a: str(f?.a, 600) })).filter((f) => f.q && f.a);
  const restaurant = {
    ...R,
    name: str(R.name, 60) || "Ristorante",
    tagline: str(R.tagline, 80),
    order_prefix: (str(R.order_prefix, 4).toUpperCase().replace(/[^A-Z]/g, "") || "ORD"),
    address: str(R.address, 120), postal_code: str(R.postal_code, 10), city: str(R.city, 60),
    province: str(R.province, 4), region: str(R.region, 40), country: str(R.country, 40),
    google_review_url: /^https:\/\/[^\s"'<>]+$/.test(String(R.google_review_url || "").trim()) ? str(R.google_review_url, 300) : "",
    phone: str(R.phone, 40), whatsapp: cleanWa(R.whatsapp), email: str(R.email, 80), website: str(R.website, 120),
    description: str(R.description, 1200), closing_days: str(R.closing_days, 300), info: str(R.info, 800),
    seats: int(R.seats, 0, 2000, 0),
    hero: typeof R.hero === "string" && /^\/api\/foto\?id=COPERTINA&v=\d+$/.test(R.hero) ? R.hero : null,
    waiter_img: typeof R.waiter_img === "string" && /^\/api\/foto\?id=AVATAR&v=\d+$/.test(R.waiter_img) ? R.waiter_img : null,
    logo: typeof R.logo === "string" && /^\/api\/foto\?id=LOGO&v=\d+$/.test(R.logo) ? R.logo : null,
    takeaway_on: !!R.takeaway_on,
    takeaway_min: int(R.takeaway_min, 5, 180, 20),
    takeaway_open_before: int(R.takeaway_open_before, 0, 180, 30),
    takeaway_close_before: int(R.takeaway_close_before, 0, 180, 30),
    tables_count: int(R.tables_count, 1, 200, 1),
    opening_hours: days7(R.opening_hours),
    services: (Array.isArray(R.services) ? R.services : []).map((s) => str(s, 80)).filter(Boolean).slice(0, 30),
    closures,
    lunch_until: HM_RE.test(String(R.lunch_until || "")) ? R.lunch_until : "16:00",
    late_min: int(R.late_min, 3, 90, 15),
    booking_on: R.booking_on !== false,
    booking_hours: days7(R.booking_hours),
    booking_step: [15, 30, 60].includes(Number(R.booking_step)) ? Number(R.booking_step) : 30,
    booking_last_before: int(R.booking_last_before, 0, 240, 60),
    booking_capacity: int(R.booking_capacity, 0, 2000, 0),
    marina: { faq, updatedAt: str(R.marina?.updatedAt, 40) || null },
  };
  const ids = new Set();
  let total = 0;
  const categories = cats.map((c) => {
    const items = (Array.isArray(c?.items) ? c.items : []).map((p) => {
      const id = str(p?.id, 8).toUpperCase();
      if (!/^[A-Z]{1,2}\d{2,3}$/.test(id)) throw new Error("Codice prodotto non valido: " + id);
      if (ids.has(id)) throw new Error("Codice prodotto duplicato: " + id);
      ids.add(id);
      const name = str(p.name, 90);
      if (!name) throw new Error("Un prodotto non ha il nome");
      const price = Math.round(Number(p.price) * 100) / 100;
      if (!Number.isFinite(price) || price < 0 || price > 5000) throw new Error(`Prezzo non valido per "${name}"`);
      const img = typeof p.img === "string" && /^\/api\/foto\?id=[A-Z0-9]+&v=\d+$/.test(p.img) ? p.img : null;
      const out = {
        id, name, price, img,
        desc: str(p.desc, 300),
        ingr: str(p.ingr, 400),
        all: (Array.isArray(p.all) ? p.all : []).filter((a) => ALLERGENS.includes(a)),
        veg: !!p.veg,
        star: !!p.star,
        av: p.av !== false,
      };
      if (p.hidden) out.hidden = true;
      if (p.when === "pranzo" || p.when === "cena") out.when = p.when;
      if (p.qty !== null && p.qty !== undefined && p.qty !== "") out.qty = int(p.qty, 0, 999, 0);
      if (DAY_RE.test(String(p.out_until || ""))) out.out_until = p.out_until;
      if (DAY_RE.test(String(p.all_ok || ""))) out.all_ok = p.all_ok;
      return out;
    });
    total += items.length;
    return { name: str(c.name, 40) || "Categoria", items };
  });
  if (total > 400) throw new Error("Troppi prodotti (massimo 400)");
  return { restaurant, categories };
}

// la disponibilità del giorno (esaurito, non disponibile) si cambia solo con PATCH:
// pubblicando una bozza vecchia non si annullano gli "esaurito" segnati nel frattempo dalla sala
function keepAvailability(next, cur) {
  const byId = {};
  cur.categories.forEach((c) => c.items.forEach((p) => (byId[p.id] = p)));
  next.categories.forEach((c) => c.items.forEach((p) => {
    const o = byId[p.id];
    if (!o) return;
    p.av = o.av !== false;
    if (o.out_until) p.out_until = o.out_until; else delete p.out_until;
  }));
  return next;
}

async function quick(req, origin) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const id = String(b.id || ""), az = String(b.azione || "");
  if (!["esaurito_oggi", "disponibile", "non_disponibile"].includes(az)) return json({ error: "Azione non valida" }, 400);
  for (let i = 0; i < 5; i++) {
    const site = await loadSite(origin, { fresh: true });
    const data = JSON.parse(JSON.stringify(site.data));
    let p = null;
    data.categories.forEach((c) => c.items.forEach((x) => { if (x.id === id) p = x; }));
    if (!p) return json({ error: "Piatto non trovato" }, 404);
    if (az === "esaurito_oggi") { p.av = true; p.out_until = day(); }
    if (az === "disponibile") { p.av = true; delete p.out_until; }
    if (az === "non_disponibile") { p.av = false; delete p.out_until; }
    try {
      const rec = await saveMenu(origin, data, site.version, { keepVersion: true });
      return json({ ok: true, id, av: p.av, out_until: p.out_until || null, version: rec.version, updatedAt: rec.updatedAt });
    } catch (e) {
      if (e.status !== 409) throw e;
    }
  }
  return json({ error: "Menu modificato da un altro dispositivo, riprova" }, 409);
}

export default async (req) => {
  const origin = siteOrigin(req);
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("tutto")) {
      const bad = await needRole(req, ["titolare", "sala"]);
      if (bad) return bad;
      const s = await loadSite(origin, { fresh: true });
      return json({ data: s.data, version: s.version, updatedAt: s.updatedAt, contentAt: s.contentAt, sold: await soldToday(), today: day() });
    }
    if (req.method === "GET") {
      const s = await loadSite(origin);
      let top = [];
      try { top = (await topSellers()).filter((id) => s.byId[id] && !s.byId[id].hidden); } catch {}
      return json({ data: await publicData(s), version: s.version, updatedAt: s.updatedAt, contentAt: s.contentAt, top });
    }
    if (req.method === "PATCH") {
      const bad = await needRole(req, ["titolare", "sala"]);
      if (bad) return bad;
      return await quick(req, origin);
    }
    if (req.method === "PUT") {
      const bad = await needRole(req, ["titolare"]);
      if (bad) return bad;
      let body;
      try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
      let data;
      try { data = validate(body.data); } catch (e) { return json({ error: e.message }, 400); }
      for (let i = 0; ; i++) {
        const cur = await loadSite(origin, { fresh: true });
        const next = keepAvailability(JSON.parse(JSON.stringify(data)), cur.data);
        try {
          const rec = await saveMenu(origin, next, body.baseVersion);
          return json({ version: rec.version, updatedAt: rec.updatedAt, data: next });
        } catch (e) { if (!e.retry || i >= 4) throw e; }
      }
    }
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: e.status === 409 ? e.message : "Errore del server, riprova" }, e.status || 500);
  }
};

export const config = { path: "/api/menu" };
