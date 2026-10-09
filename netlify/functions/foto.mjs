// Foto dei piatti caricate dal pannello
//   GET  /api/foto?id=P16&v=...   foto (pubblica, messa in cache dal browser)
//   POST /api/foto?id=P16         il titolare carica una foto (ADMIN_PIN), max 600 KB
//   id speciali: COPERTINA (foto della hero) e LOGO
import { json, needRole, store } from "../lib/menu.mjs";

const TYPES = ["image/webp", "image/jpeg", "image/png"];

export default async (req) => {
  const url = new URL(req.url);
  const id = String(url.searchParams.get("id") || "").toUpperCase();
  if (!/^([A-Z]{1,2}\d{2,3}|COPERTINA|LOGO|AVATAR)$/.test(id)) return json({ error: "Codice non valido" }, 400);
  const s = store();

  if (req.method === "GET") {
    const r = await s.getWithMetadata(`img/${id}`, { type: "arrayBuffer" });
    if (!r) return new Response("Foto non trovata", { status: 404 });
    return new Response(r.data, {
      headers: { "Content-Type": r.metadata?.type || "image/webp", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  }

  if (req.method === "POST") {
    const bad = await needRole(req, ["titolare"]);
    if (bad) return bad;
    const type = (req.headers.get("content-type") || "").split(";")[0];
    if (!TYPES.includes(type)) return json({ error: "Formato non supportato (usa JPG, PNG o WebP)" }, 400);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 600 * 1024) return json({ error: "Foto troppo grande (massimo 600 KB)" }, 413);
    await s.set(`img/${id}`, buf, { metadata: { type } });
    return json({ url: `/api/foto?id=${id}&v=${Date.now()}` });
  }

  return json({ error: "Metodo non consentito" }, 405);
};

export const config = { path: "/api/foto" };
