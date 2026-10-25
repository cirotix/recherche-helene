// Worker Cloudflare – partage en direct de la recherche
// Bindings : KV namespace "STATUS" ; variable secrète "CODE" (code équipe partagé sur WhatsApp)
// GET  /state            -> {secteurs:{A1:{s,e,n,t}}, points:[{id,lat,lng,txt,t,who}]}
// POST /sector  {code,id,s,e,n}
// POST /point   {code,lat,lng,txt,who}
// POST /point/delete {code,id}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (o, st = 200) =>
  new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
const clip = (s, n) => String(s ?? "").slice(0, n);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/state") {
      const secteurs = {}, points = [];
      let cursor;
      do {
        const r = await env.STATUS.list({ cursor });
        for (const k of r.keys) {
          if (!k.metadata) continue;
          if (k.name.startsWith("s:")) secteurs[k.name.slice(2)] = k.metadata;
          else if (k.name.startsWith("p:")) points.push({ id: k.name.slice(2), ...k.metadata });
        }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
      points.sort((a, b) => a.t - b.t);
      return json({ secteurs, points, now: Date.now() });
    }

    if (req.method !== "POST") return json({ error: "not found" }, 404);
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!env.CODE || b.code !== env.CODE) return json({ error: "code" }, 403);

    if (url.pathname === "/sector") {
      if (!/^[A-Z]\d{1,2}$/.test(b.id || "")) return json({ error: "id" }, 400);
      if (!["todo", "doing", "done", "alert"].includes(b.s)) return json({ error: "s" }, 400);
      const meta = { s: b.s, e: clip(b.e, 60), n: clip(b.n, 300), t: Date.now() };
      await env.STATUS.put("s:" + b.id, "1", { metadata: meta });
      return json({ ok: true, meta });
    }
    if (url.pathname === "/point") {
      const lat = +b.lat, lng = +b.lng;
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "pos" }, 400);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const meta = { lat, lng, txt: clip(b.txt, 300), who: clip(b.who, 40), t: Date.now() };
      await env.STATUS.put("p:" + id, "1", { metadata: meta });
      return json({ ok: true, id });
    }
    if (url.pathname === "/point/delete") {
      await env.STATUS.delete("p:" + clip(b.id, 40));
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
