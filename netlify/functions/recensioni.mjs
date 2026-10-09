// Voti dei clienti (1–5 stelle + commento facoltativo)
//   POST /api/recensioni  {id, t, stars, comment}   il cliente vota il suo ordine servito   (pubblico, con codice segreto dell'ordine)
//   GET  /api/recensioni?dal=..&al=..                 il titolare legge i voti                 (ADMIN_PIN)
// Un solo voto per ordine. Salvati in Netlify Blobs come "rev/<data>/<id ordine>".
import { day, json, needRole, store } from "../lib/menu.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);

async function vote(req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  const m = /^(\d{4}-\d{2}-\d{2})_[a-z0-9]+$/.exec(String(b.id || ""));
  if (!m) return json({ error: "Ordine non valido" }, 400);
  const stars = Number(b.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "Scegli da 1 a 5 stelle" }, 400);
  const s = store();
  const o = await s.get(`o/${m[1]}/${b.id}`, { type: "json" });
  if (!o || o.token !== b.t) return json({ error: "Ordine non trovato" }, 404);
  if (o.status !== "served") return json({ error: "Potrai votare quando l'ordine è stato servito" }, 409);
  const rec = {
    id: o.id, code: o.code, type: o.type || "tavolo", table: o.table ?? null, total: o.total,
    stars, comment: clean(b.comment, 600), createdAt: new Date().toISOString(),
  };
  const w = await s.setJSON(`rev/${m[1]}/${o.id}`, rec, { onlyIfNew: true });
  if (!w.modified) return json({ error: "Hai già lasciato il tuo voto, grazie!" }, 409);
  return json({ ok: true }, 201);
}

async function list(req) {
  const bad = await needRole(req, ["titolare"]);
  if (bad) return bad;
  const u = new URL(req.url), today = day();
  const dal = DAY_RE.test(u.searchParams.get("dal") || "") ? u.searchParams.get("dal") : today;
  const al = DAY_RE.test(u.searchParams.get("al") || "") ? u.searchParams.get("al") : today;
  const days = [], d = new Date(dal + "T12:00:00Z"), end = new Date(al + "T12:00:00Z");
  while (d <= end && days.length < 92) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const s = store();
  const lists = await Promise.all(days.map(async (x) => {
    const { blobs } = await s.list({ prefix: `rev/${x}/` });
    return (await Promise.all(blobs.map((bl) => s.get(bl.key, { type: "json" })))).filter(Boolean);
  }));
  const reviews = lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const dist = [0, 0, 0, 0, 0];
  reviews.forEach((r) => dist[r.stars - 1]++);
  const avg = reviews.length ? Math.round((reviews.reduce((t, r) => t + r.stars, 0) / reviews.length) * 10) / 10 : null;
  return json({ dal, al, count: reviews.length, avg, dist, reviews: reviews.slice(0, 500) });
}

export default async (req) => {
  try {
    if (req.method === "POST") return await vote(req);
    if (req.method === "GET") return await list(req);
    return json({ error: "Metodo non consentito" }, 405);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server" }, 500);
  }
};

export const config = { path: "/api/recensioni" };
