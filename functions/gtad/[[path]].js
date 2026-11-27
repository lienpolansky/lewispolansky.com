// lewispolansky.com/gtad: the download page for Grand Towing and Delivery, and the files its in-game updater fetches.
//
// The rule: one shared code in the link, /gtad/?k=CODE. It is there to keep bots and strangers out, not to protect a secret.
// The right code sets a cookie (400 days) and sends the browser on to /gtad/ without the code in its address. Without the cookie
// the page itself still loads, but the build list (gtad.json), the builds, the update manifest and its signature answer 401,
// so the page shows only "Ask Lewis for the link". Copies of the game made for friends carry a token instead (?t=), worked out
// from the same code. The code lives only in the project's secret PASSCODE, never in this repository; with no secret set
// everything behind it stays shut.
//
// Builds, the manifest and its signature come from the R2 bucket bound as BUCKET, with byte ranges so a broken download carries
// on. The page and its pictures are this site's own files (public/gtad). POST /gtad/stats keeps one opt-in performance report
// per file under stats/ in the bucket: no address, no name, never served back.
//
// /gtad/towns lists the open towns games are hosting (towns(), below), behind the same token.
//
// Where the bindings are set: BUCKET (the R2 bucket "gtad") and the secret PASSCODE are in the Pages project's production
// settings (lewispolansky-static), not in a wrangler file, so nothing else about the site's deploy changes.

const PREFIX = "/gtad", COOKIE = "gtad", COOKIE_DAYS = 400, MOST_REPORT = 8192;
const LOCKED = k => k.startsWith("builds/") || k === "manifest.json" || k === "manifest.json.sig" || k === "gtad.json";
const FROM_BUCKET = k => k.startsWith("builds/") || k === "manifest.json" || k === "manifest.json.sig" || k === "gtad.json";
const FIELDS = { v: "number", version: "string", platform: "string", hardware: "string", level: "string", minutes: "number", areas: "object" };

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url); const path = url.pathname;
  if (path === PREFIX) return Response.redirect(url.origin + PREFIX + "/" + url.search, 301);
  let key = path.slice(PREFIX.length + 1); if (key === "" || key.endsWith("/")) key += "index.html";
  if (key === "index.html" && url.searchParams.has("k") && (request.method === "GET" || request.method === "HEAD")) return linkCode(request, env, url);
  if (key === "unlock") return request.method === "POST" ? unlock(request, env) : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (key === "log") return request.method === "POST" ? log(request, env, url) : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (key === "towns") return towns(request, env, url);
  if (key === "bug") return request.method === "POST" ? bug(request, env) : new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (key === "stats") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!(await allowed(request, env))) return new Response("Ask Lewis for the link", { status: 401 });
    return stats(request, env);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(key) || key.includes("..") || key.startsWith("stats/") || key.startsWith("bugs/") || key.startsWith("logs/") || key.startsWith("towns/")) return new Response("Not found", { status: 404 });
  if (LOCKED(key) && !(await allowed(request, env))) return new Response("Ask Lewis for the link", { status: 401, headers: { "Cache-Control": "no-store" } });
  if (FROM_BUCKET(key) && env.BUCKET) { const r = await serve(request, env, key); if (r) return r; }
  if (key.startsWith("builds/") || key.startsWith("manifest")) return new Response("Not found", { status: 404 });
  const res = await next();                                     // the page, its pictures, and gtad.json until the bucket has one
  if (!LOCKED(key)) return res;
  const h = new Headers(res.headers); h.set("Cache-Control", "no-store"); return new Response(res.body, { status: res.status, headers: h });
}

const enc = new TextEncoder();
async function hmac(secret, what) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(what)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) { if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export const pageKey = p => hmac(p, "gtad page v1");
export const updaterToken = async p => (await hmac(p, "gtad updater v1")).slice(0, 32);
function cookie(request, name) { for (const part of (request.headers.get("Cookie") || "").split(";")) { const [k, ...v] = part.trim().split("="); if (k === name) return v.join("="); } return ""; }
async function cookieLine(env) { return `${COOKIE}=${await pageKey(env.PASSCODE)}; Path=${PREFIX}; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`; }
async function rightCode(env, given) { return !!env.PASSCODE && same(await hmac(env.PASSCODE, "try " + (given || "")), await hmac(env.PASSCODE, "try " + env.PASSCODE)); }

async function allowed(request, env) {
  if (!env.PASSCODE) return false;                               // no secret set: shut, never open
  const t = new URL(request.url).searchParams.get("t"); if (t && same(t, await updaterToken(env.PASSCODE))) return true;
  return same(cookie(request, COOKIE), await pageKey(env.PASSCODE));
}

// A few tries a minute from one place, kept only in this copy's memory (Pages has no shared limiter); nothing is written down.
const tries = new Map();
function limited(request, most, seen = tries) {
  const who = request.headers.get("CF-Connecting-IP") || "unknown", now = Date.now(), t = (seen.get(who) || []).filter(x => now - x < 60000);
  t.push(now); seen.set(who, t); if (seen.size > 5000) seen.clear(); return t.length > most;
}

async function linkCode(request, env, url) {
  const headers = new Headers({ Location: url.origin + PREFIX + "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (!limited(request, 5) && (await rightCode(env, url.searchParams.get("k")))) headers.set("Set-Cookie", await cookieLine(env));
  return new Response(null, { status: 302, headers });
}

async function unlock(request, env) {
  if (limited(request, 5)) return new Response("Too many tries. Wait a minute.", { status: 429, headers: { "Retry-After": "60" } });
  let given = ""; const kind = request.headers.get("Content-Type") || "";
  try {
    const text = await request.text(); if (text.length > 512) return new Response("Too large", { status: 413 });
    given = kind.includes("json") ? String(JSON.parse(text).passcode || "") : new URLSearchParams(text).get("passcode") || "";
  } catch { return new Response("Bad request", { status: 400 }); }
  if (!(await rightCode(env, given))) return new Response("Wrong code", { status: 403 });
  return new Response(null, { status: 204, headers: { "Set-Cookie": await cookieLine(env), "Cache-Control": "no-store" } });
}

export function parseRange(h, size) {
  if (!h) return null; const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim()); if (!m || (m[1] === "" && m[2] === "")) return false;
  if (m[1] === "") { const n = Math.min(Number(m[2]), size); return n > 0 ? { offset: size - n, length: n } : false; }
  const a = Number(m[1]), b = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return a < size && b >= a ? { offset: a, length: b - a + 1 } : false;
}

// From the bucket, or null when it does not hold that file.
async function serve(request, env, key) {
  const head = await env.BUCKET.head(key); if (!head) return null;
  const headers = new Headers(); head.writeHttpMetadata(headers); headers.set("ETag", head.httpEtag); headers.set("Accept-Ranges", "bytes");
  if (LOCKED(key)) headers.set("Cache-Control", key.startsWith("builds/") ? "private, max-age=31536000, immutable" : "no-store");
  if (request.headers.get("If-None-Match") === head.httpEtag) return new Response(null, { status: 304, headers });
  let range = parseRange(request.headers.get("Range"), head.size);
  const ifRange = request.headers.get("If-Range"); if (range && ifRange && ifRange !== head.httpEtag) range = null;
  if (range === false) { headers.set("Content-Range", `bytes */${head.size}`); return new Response(null, { status: 416, headers }); }
  if (request.method === "HEAD") { headers.set("Content-Length", String(head.size)); return new Response(null, { status: 200, headers }); }
  const obj = await env.BUCKET.get(key, range ? { range } : {}); if (!obj) return null;
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`); headers.set("Content-Length", String(range.length)); return new Response(obj.body, { status: 206, headers }); }
  headers.set("Content-Length", String(head.size)); return new Response(obj.body, { status: 200, headers });
}

export function cleanReport(text) {
  if (text.length > MOST_REPORT) return null; let r; try { r = JSON.parse(text); } catch { return null; }
  if (!r || typeof r !== "object" || Array.isArray(r) || r.v !== 1) return null; const out = {};
  for (const [k, v] of Object.entries(r)) { if (!(k in FIELDS) || typeof v !== FIELDS[k] || v === null) return null; out[k] = v; }
  for (const [name, a] of Object.entries(out.areas || {})) {
    if (!/^[A-Za-z0-9 ._-]{1,24}$/.test(name) || !a || typeof a !== "object" || Object.keys(a).sort().join() !== "frames,median_ms" || !Number.isInteger(a.frames) || !Number.isInteger(a.median_ms)) return null;
  }
  return out;
}

async function readCapped(request, most) {
  if (!request.body) return ""; const reader = request.body.getReader(); const parts = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > most) { try { await reader.cancel(); } catch {} return null; } parts.push(value); }
  const all = new Uint8Array(n); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; } return new TextDecoder().decode(all);
}

// ---------- bug reports from the game's F8 reporter ----------
// POST /gtad/bug with X-Gtad-Token (the game's updater token, the same check as the ledger). Multipart with a "report" field
// (JSON text, up to 512 KB) and an optional "shot" (JPEG, up to 3 MB), or JSON {"report": {...}, "shot": "<base64 JPEG>"}.
// Stored in the bucket at bugs/<UTC date>/<HHMMSS>-<player>-<6 hex>/report.json and shot.jpg; never served back from here.
// At most 30 an hour from one address, counted in the ledger's D1 (the hashed address only).
const MOST_BUG_REPORT = 512 * 1024, MOST_SHOT = 3 * 1024 * 1024, MOST_BUG_BODY = 5 * 1024 * 1024, BUGS_AN_HOUR = 30;
// Global towns (net-2's contract for 0.12.4). A game hosting an open town POSTs it every 20 s; GET lists those heard from in the
// last 60 s, oldest dropped and deleted; DELETE /gtad/towns?town=<id> takes one off. All three need the game's token (X-Gtad-Token
// or ?t=). One small object per town under towns/ in the bucket, never served by any other path. Stored with Cloudflare's region
// and country of the host, never the address or the city.
//   POST {"town":"29b91774","host":"Lewis","players":2,"max":12,"build":"0.12.4 (abc1234)","protocol":12,"code":"7R8CFN"} -> 204
//   GET -> 200 {"towns":[{town,host,players,max,build,protocol,code,region,country,age}]}, age in seconds since last heard
const TOWN_LIFE = 60000, TOWN_BODY = 2048, townTries = new Map();
function townFrom(o) {
  if (!o || typeof o !== "object") return "body";
  if (typeof o.town !== "string" || !/^[0-9a-f]{8}$/.test(o.town)) return "town";
  const host = typeof o.host === "string" ? o.host.trim() : ""; if (!host || [...host].length > 16 || /[\u0000-\u001f\u007f]/.test(host)) return "host";
  for (const k of ["players", "max"]) if (!Number.isInteger(o[k]) || o[k] < 1 || o[k] > 12) return k;
  if (typeof o.build !== "string" || o.build.length > 40 || /[^\x20-\x7e]/.test(o.build)) return "build";
  if (!Number.isInteger(o.protocol) || o.protocol < 0 || o.protocol > 1e6) return "protocol";
  if (typeof o.code !== "string" || !/^[A-Z0-9]{6}$/.test(o.code)) return "code";
  return { town: o.town, host, players: o.players, max: o.max, build: o.build, protocol: o.protocol, code: o.code };
}
async function towns(request, env, url) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST, DELETE" } });
  if (!env.BUCKET || !env.PASSCODE) return bugJson({ ok: false, error: "no towns yet" }, 503);
  const token = request.headers.get("X-Gtad-Token") || url.searchParams.get("t") || "";
  if (!same(token, await updaterToken(env.PASSCODE))) return new Response("Ask Lewis for the link", { status: 401, headers: { "Cache-Control": "no-store" } });
  if (limited(request, 120, townTries)) return bugJson({ ok: false, error: "slow down" }, 429);
  if (request.method === "DELETE") {
    const id = url.searchParams.get("town") || ""; if (!/^[0-9a-f]{8}$/.test(id)) return bugJson({ ok: false, error: "bad request", why: "town" }, 400);
    await env.BUCKET.delete(`towns/${id}.json`); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > TOWN_BODY) return bugJson({ ok: false, error: "too big", most: TOWN_BODY }, 413);
    const text = await request.text(); if (text.length > TOWN_BODY) return bugJson({ ok: false, error: "too big", most: TOWN_BODY }, 413);
    let o; try { o = JSON.parse(text); } catch { return bugJson({ ok: false, error: "bad request", why: "json" }, 400); }
    const t = townFrom(o); if (typeof t === "string") return bugJson({ ok: false, error: "bad request", why: t }, 400);
    const cf = request.cf || {}, entry = { ...t, region: String(cf.region || "").slice(0, 80), country: String(cf.country || "").slice(0, 8), seen: Date.now() };
    await env.BUCKET.put(`towns/${t.town}.json`, JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  const now = Date.now(), out = [], stale = []; let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: "towns/", cursor }); cursor = page.truncated ? page.cursor : undefined;
    for (const ob of page.objects) {
      const got = await env.BUCKET.get(ob.key); let e = null; try { e = got ? JSON.parse(await got.text()) : null; } catch { e = null; }
      if (!e || typeof e.seen !== "number" || now - e.seen > TOWN_LIFE) { stale.push(ob.key); continue; }
      const { seen, ...rest } = e; out.push({ ...rest, age: Math.max(0, Math.round((now - seen) / 1000)) });
    }
  } while (cursor);
  if (stale.length) await env.BUCKET.delete(stale);
  out.sort((a, b) => a.age - b.age || a.town.localeCompare(b.town));
  return bugJson({ towns: out }, 200);
}

const bugJson = (o, status) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function bug(request, env) {
  if (!env.BUCKET || !env.PASSCODE) return bugJson({ ok: false, error: "not taking reports yet" }, 503);
  if (!same(request.headers.get("X-Gtad-Token") || "", await updaterToken(env.PASSCODE))) return bugJson({ ok: false, error: "ask Lewis for the link" }, 401);
  if (Number(request.headers.get("Content-Length") || 0) > MOST_BUG_BODY) return bugJson({ ok: false, error: "too big" }, 413);
  if (env.LEDGER) {
    const now = Date.now(), w = Math.floor(now / 3_600_000), ip = request.headers.get("CF-Connecting-IP") || "local";
    const k = "g:" + (await hmac("bug reports", ip)).slice(0, 24);
    const r = await env.LEDGER.prepare("INSERT INTO hits (key, window, n) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET n = n + 1 RETURNING n").bind(k, w).first();
    if (r && r.n === 1) await env.LEDGER.prepare("DELETE FROM hits WHERE key = ? AND window < ?").bind(k, w).run();
    if (r && r.n > BUGS_AN_HOUR) return bugJson({ ok: false, error: "slow down", retry_ms: (w + 1) * 3_600_000 - now }, 429);
  }
  let reportText = null, shot = null; const type = (request.headers.get("Content-Type") || "").toLowerCase();
  try {
    if (type.startsWith("multipart/form-data")) {
      const f = await request.formData(); const r = f.get("report"), s = f.get("shot");
      reportText = typeof r === "string" ? r : r && typeof r.text === "function" ? await r.text() : null;
      if (s && typeof s.arrayBuffer === "function") shot = new Uint8Array(await s.arrayBuffer());
    } else {
      const body = await request.text(); if (body.length > MOST_BUG_BODY) return bugJson({ ok: false, error: "too big" }, 413);
      const j = JSON.parse(body); reportText = j && j.report !== undefined ? JSON.stringify(j.report) : null;
      if (j && typeof j.shot === "string" && j.shot.length) shot = Uint8Array.from(atob(j.shot.replace(/^data:image\/jpeg;base64,/, "")), c => c.charCodeAt(0));
    }
  } catch (e) { return bugJson({ ok: false, error: "bad request", why: "body" }, 400); }
  if (reportText === null) return bugJson({ ok: false, error: "bad request", why: "report" }, 400);
  if (new TextEncoder().encode(reportText).length > MOST_BUG_REPORT) return bugJson({ ok: false, error: "too big", why: "report" }, 413);
  let report; try { report = JSON.parse(reportText); } catch (e) { return bugJson({ ok: false, error: "bad request", why: "report is not JSON" }, 400); }
  if (!report || typeof report !== "object" || Array.isArray(report)) return bugJson({ ok: false, error: "bad request", why: "report" }, 400);
  if (shot && shot.length > MOST_SHOT) return bugJson({ ok: false, error: "too big", why: "shot" }, 413);
  if (shot && !(shot[0] === 0xff && shot[1] === 0xd8 && shot[2] === 0xff)) return bugJson({ ok: false, error: "bad request", why: "shot is not a JPEG" }, 400);
  // the client's own id for the report makes a resend land once: the second time gets the first answer back
  const cid = typeof report.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(report.id) ? report.id : null, mark = cid ? `bugs/_ids/${cid}` : null;
  if (mark) { const was = await env.BUCKET.get(mark); if (was) return bugJson({ ok: true, id: await was.text(), repeat: true }, 200); }
  const at = new Date(), day = at.toISOString().slice(0, 10), time = at.toISOString().slice(11, 19).replace(/:/g, "");
  const who = String(report.player || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "anon";
  const id = `${day}/${time}-${who}-${[...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, "0")).join("")}`;
  const stored = { ...report, _received: { at: at.toISOString(), ...where(request), agent: (request.headers.get("User-Agent") || "").slice(0, 200), shot: !!shot } };
  await env.BUCKET.put(`bugs/${id}/report.json`, JSON.stringify(stored, null, 1), { httpMetadata: { contentType: "application/json" }, customMetadata: where(request) });
  if (shot) await env.BUCKET.put(`bugs/${id}/shot.jpg`, shot, { httpMetadata: { contentType: "image/jpeg" } });
  if (mark) await env.BUCKET.put(mark, id, { httpMetadata: { contentType: "text/plain" } });
  return bugJson({ ok: true, id }, 201);
}

// ---------- game logs, sent a chunk at a time ----------
// POST /gtad/log?player=<name>&session=<id>&n=<chunk> with X-Gtad-Token and one gzip chunk (at most 512 KB) as the body.
// The same can come as ?t=<token> with headers X-Gtad-Player, X-Gtad-Session and X-Gtad-Part (net-2's sender).
// Stored at logs/<UTC date>/<player>-<session>/<n>.log.gz, with where() and facts() as the object's metadata; the same chunk sent again overwrites itself. Never served back.
// 2000 chunks an hour from one address: room for a house full of players each sending every minute.
const MOST_LOG = 512 * 1024, LOGS_AN_HOUR = 2000;
// Where a sender is, as Cloudflare places the address (city, region, country, its time zone): stamped on each log chunk and bug
// report, so a log's clock times can be read in the player's own time. Never the address itself; a field Cloudflare lacks is "".
// What the game says about itself on each log part (net-2's LogShip): X-Gtad-Name, -Build, -Gpu and -Character, printable ASCII,
// clipped to 60; one it does not send is left out.
function facts(request) { const o = {}; for (const [k, h] of [["name", "X-Gtad-Name"], ["build", "X-Gtad-Build"], ["gpu", "X-Gtad-Gpu"], ["character", "X-Gtad-Character"]]) { const v = String(request.headers.get(h) || "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60); if (v) o[k] = v; } return o; }
function where(request) { const cf = request.cf || {}, t = v => String(v == null ? "" : v).slice(0, 80); return { city: t(cf.city), region: t(cf.region), country: t(cf.country), timezone: t(cf.timezone) }; }
async function log(request, env, url) {
  if (!env.BUCKET || !env.PASSCODE) return bugJson({ ok: false, error: "not taking logs yet" }, 503);
  const token = request.headers.get("X-Gtad-Token") || url.searchParams.get("t") || "";
  if (!same(token, await updaterToken(env.PASSCODE))) return bugJson({ ok: false, error: "ask Lewis for the link" }, 401);
  if (Number(request.headers.get("Content-Length") || 0) > MOST_LOG) return bugJson({ ok: false, error: "too big", most: MOST_LOG }, 413);
  const h = k => request.headers.get(k);
  const session = url.searchParams.get("session") || h("X-Gtad-Session") || "", n = url.searchParams.get("n") || h("X-Gtad-Part") || "";
  const who = String(url.searchParams.get("player") || h("X-Gtad-Player") || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "anon";      // room for a whole ledger id
  if (!/^[A-Za-z0-9-]{8,64}$/.test(session)) return bugJson({ ok: false, error: "bad request", why: "session" }, 400);
  if (!/^\d{1,6}$/.test(n)) return bugJson({ ok: false, error: "bad request", why: "n" }, 400);
  if (env.LEDGER) {
    const now = Date.now(), w = Math.floor(now / 3_600_000), ip = request.headers.get("CF-Connecting-IP") || "local", k = "l:" + (await hmac("game logs", ip)).slice(0, 24);
    const r = await env.LEDGER.prepare("INSERT INTO hits (key, window, n) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET n = n + 1 RETURNING n").bind(k, w).first();
    if (r && r.n === 1) await env.LEDGER.prepare("DELETE FROM hits WHERE key = ? AND window < ?").bind(k, w).run();
    if (r && r.n > LOGS_AN_HOUR) return bugJson({ ok: false, error: "slow down", retry_ms: (w + 1) * 3_600_000 - now }, 429);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MOST_LOG) return bugJson({ ok: false, error: "too big", most: MOST_LOG }, 413);
  if (body.length < 18 || body[0] !== 0x1f || body[1] !== 0x8b) return bugJson({ ok: false, error: "bad request", why: "not gzip" }, 400);
  const k = `logs/${new Date().toISOString().slice(0, 10)}/${who}-${session}/${n.padStart(6, "0")}.log.gz`;
  await env.BUCKET.put(k, body, { httpMetadata: { contentType: "application/gzip" }, customMetadata: { ...where(request), ...facts(request) } });
  return bugJson({ ok: true, key: k.slice(5) }, 201);
}

async function stats(request, env) {
  if (!env.BUCKET) return new Response("Not taking reports yet", { status: 503 });
  if (limited(request, 6)) return new Response("Too many reports", { status: 429, headers: { "Retry-After": "60" } });
  const text = await readCapped(request, MOST_REPORT); if (text === null) return new Response("Too large", { status: 413 });
  const r = cleanReport(text); if (!r) return new Response("Bad report", { status: 400 });
  const day = new Date().toISOString().slice(0, 10);
  await env.BUCKET.put(`stats/${day}/${crypto.randomUUID()}.json`, JSON.stringify({ received: new Date().toISOString(), ...r }), { httpMetadata: { contentType: "application/json" } });
  return new Response(null, { status: 204 });
}
