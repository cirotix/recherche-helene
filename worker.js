// Worker Cloudflare – partage en direct de la recherche
// Un Durable Object unique garde l'état et le diffuse en websocket à tous les téléphones connectés.
// Binding : Durable Object "SEARCH"
// Secrets : "CODE" (code équipe partagé sur WhatsApp), "ADMIN" (code du coordinateur)
// Les codes ne tiennent compte ni des majuscules ni des accents.
// GET  /state            -> {secteurs:{A1:{s,e,n,d,f,ds,t}}, points:[{id,lat,lng,txt,t,who}]}
// GET  /ws               -> websocket : reçoit l'état complet à la connexion puis à chaque changement
// POST /sector  {code,admin,id,s,e,n,d,f}  correction manuelle, coordinateur seulement ; d/f : heures "HH:MM"
// POST /sector/start {code,id,e,o,admin?} commence la recherche ; o : jeton de l'appareil ;
//                                          rouvrir un secteur déjà fait demande le code coordinateur
// POST /sector/stop  {code,id,o,n}   termine ; seul l'appareil qui a commencé peut arrêter
// POST /sector/done  {code,id,e,d,f,n} déclare un secteur déjà fait (heures saisies par le bénévole)
// POST /point   {code,lat,lng,txt,who}
// POST /point/delete {code,id}
// POST /restart {code}  recharge l'objet après un déploiement (l'état est conservé)

import { DurableObject } from "cloudflare:workers";

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
const VERSION = 4;
const validId = (id) => /^[A-Z]\d{1,2}$/.test(id || "");
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const sameCode = (given, secret) => !!secret && norm(given) === norm(secret);

export class Search extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || { secteurs: {}, points: {} };
    });
  }

  // État visible par tous : jamais le jeton du propriétaire
  publicState() {
    const secteurs = {};
    for (const [id, { o, ...pub }] of Object.entries(this.state.secteurs)) secteurs[id] = pub;
    const points = Object.entries(this.state.points).map(([id, p]) => ({ id, ...p })).sort((a, b) => a.t - b.t);
    return { secteurs, points, now: Date.now() };
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
    const msg = JSON.stringify(this.publicState());
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "websocket attendu" }, 426);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(this.publicState()));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "GET" && url.pathname === "/state") return json(this.publicState());

    if (req.method !== "POST") return json({ error: "not found" }, 404);
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!sameCode(b.code, this.env.CODE)) return json({ error: "code" }, 403);
    const isAdmin = sameCode(b.admin, this.env.ADMIN);

    // Après un déploiement, l'objet en mémoire garde l'ancien code : on le relance
    if (url.pathname === "/restart") {
      setTimeout(() => this.ctx.abort("redémarrage"), 50);
      return json({ ok: true, version: VERSION });
    }

    if (url.pathname === "/sector/start" || url.pathname === "/sector/stop") {
      if (!validId(b.id)) return json({ error: "id" }, 400);
      const owner = clip(b.o, 40);
      if (!owner) return json({ error: "o" }, 400);
      const cur = this.state.secteurs[b.id];
      let meta;
      if (url.pathname === "/sector/start") {
        if (cur?.s === "doing" && cur.o !== owner)
          return json({ error: "Secteur déjà en cours" + (cur.e ? " par " + cur.e : "") + " depuis " + cur.d }, 409);
        if (cur?.s === "done" && !isAdmin) return json({ error: "admin" }, 403);
        meta = { s: "doing", e: clip(b.e, 60), n: cur?.n || "", d: nowParis(), f: "", ds: Date.now(), o: owner, t: Date.now() };
      } else {
        if (cur?.s !== "doing") return json({ error: "Ce secteur n'est pas en cours" }, 409);
        if (cur.o !== owner) return json({ error: "Seule la personne qui a commencé peut terminer" }, 403);
        meta = { ...cur, s: "done", n: b.n == null ? cur.n : clip(b.n, 300), f: nowParis(), t: Date.now() };
      }
      this.state.secteurs[b.id] = meta;
      await this.save();
      const { o, ...pub } = meta;
      return json({ ok: true, meta: pub });
    }
    if (url.pathname === "/sector/done") {
      if (!validId(b.id)) return json({ error: "id" }, 400);
      const cur = this.state.secteurs[b.id];
      if (cur?.s === "doing") return json({ error: "Secteur en cours" + (cur.e ? " par " + cur.e : "") }, 409);
      if (cur?.s === "done" && !isAdmin) return json({ error: "admin" }, 403);
      if (!hhmm(b.d) || !hhmm(b.f)) return json({ error: "Indiquez l'heure de début et de fin" }, 400);
      const meta = { s: "done", e: clip(b.e, 60), n: clip(b.n, 300), d: hhmm(b.d), f: hhmm(b.f), t: Date.now() };
      this.state.secteurs[b.id] = meta;
      await this.save();
      return json({ ok: true, meta });
    }
    if (url.pathname === "/sector") {
      if (!isAdmin) return json({ error: "admin" }, 403);
      if (!validId(b.id)) return json({ error: "id" }, 400);
      if (!["todo", "doing", "done", "alert"].includes(b.s)) return json({ error: "s" }, 400);
      const meta = { s: b.s, e: clip(b.e, 60), n: clip(b.n, 300), d: hhmm(b.d), f: hhmm(b.f), t: Date.now() };
      this.state.secteurs[b.id] = meta;
      await this.save();
      return json({ ok: true, meta });
    }
    if (url.pathname === "/point") {
      const lat = +b.lat, lng = +b.lng;
      if (!isFinite(lat) || !isFinite(lng)) return json({ error: "pos" }, 400);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.state.points[id] = { lat, lng, txt: clip(b.txt, 300), who: clip(b.who, 40), t: Date.now() };
      await this.save();
      return json({ ok: true, id });
    }
    if (url.pathname === "/point/delete") {
      delete this.state.points[clip(b.id, 40)];
      await this.save();
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  // Le client envoie "ping" régulièrement pour garder la connexion ouverte
  webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }
  webSocketClose(ws, code) {
    try { ws.close(code, "fin"); } catch {}
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const stub = env.SEARCH.get(env.SEARCH.idFromName("helene"));
    return stub.fetch(req);
  },
};
