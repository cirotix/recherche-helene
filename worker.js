// Worker Cloudflare – partage en direct de la recherche
// Bindings : KV namespace "STATUS" ; variable secrète "CODE" (code équipe partagé sur WhatsApp)
// GET  /state            -> {secteurs:{A1:{s,e,n,d,f,ds,t}}, points:[{id,lat,lng,txt,t,who}]}
// POST /sector  {code,id,s,e,n,d,f}  correction manuelle (coordinateur) ; d/f : heures "HH:MM"
// POST /sector/start {code,id,e,o}   commence la recherche ; o : jeton de l'appareil
// POST /sector/stop  {code,id,o,n}   termine ; seul l'appareil qui a commencé peut arrêter
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
const hhmm = (s) => (/^\d{2}:\d{2}$/.test(s || "") ? s : "");
const nowParis = () => new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const validId = (id) => /^[A-Z]\d{1,2}$/.test(id || "");

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
          if (k.name.startsWith("s:")) { const { o, ...pub } = k.metadata; secteurs[k.name.slice(2)] = pub; }
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

    if (url.pathname === "/sector/start" || url.pathname === "/sector/stop") {
      if (!validId(b.id)) return json({ error: "id" }, 400);
      const owner = clip(b.o, 40);
      if (!owner) return json({ error: "o" }, 400);
      const { metadata: cur } = await env.STATUS.getWithMetadata("s:" + b.id);
      let meta;
      if (url.pathname === "/sector/start") {
        if (cur?.s === "doing" && cur.o !== owner)
          return json({ error: "Secteur déjà en cours" + (cur.e ? " par " + cur.e : "") + " depuis " + cur.d }, 409);
        meta = { s: "doing", e: clip(b.e, 60), n: cur?.n || "", d: nowParis(), f: "", ds: Date.now(), o: owner, t: Date.now() };
      } else {
        if (cur?.s !== "doing") return json({ error: "Ce secteur n'est pas en cours" }, 409);
        if (cur.o !== owner) return json({ error: "Seule l'équipe qui a commencé peut terminer" }, 403);
        meta = { ...cur, s: "done", n: b.n == null ? cur.n : clip(b.n, 300), f: nowParis(), t: Date.now() };
      }
      await env.STATUS.put("s:" + b.id, "1", { metadata: meta });
      const { o, ...pub } = meta;
      return json({ ok: true, meta: pub });
    }
    if (url.pathname === "/sector") {
      if (!validId(b.id)) return json({ error: "id" }, 400);
      if (!["todo", "doing", "done", "alert"].includes(b.s)) return json({ error: "s" }, 400);
      const meta = { s: b.s, e: clip(b.e, 60), n: clip(b.n, 300), d: hhmm(b.d), f: hhmm(b.f), t: Date.now() };
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
