// lewispolansky.com/ledger/v1: the one global South Pas for Grand Towing and Delivery. Money, who owns what, unlocks and trades live
// here, in D1 (bound to the Pages project as LEDGER, schema in ledger/schema.sql); each game keeps its local save as the fallback.
// The contract is ledger/CONTRACT.md. In short:
//   POST /ledger/v1/accounts   make an account (needs the game's token from the /gtad code); answers its id and secret, once
//   GET  /ledger/v1/me         my cash, places and unlocks                     (signed)
//   GET  /ledger/v1/world      every account's name and cash, every owner      (signed)
//   GET  /ledger/v1/feed       ledger lines after a sequence number            (signed)
//   POST /ledger/v1/commit     a host's batch of changes: all of it or none, once per batch id   (signed by the host)
//   POST /ledger/v1/import     bring a local save in, once per account         (signed)
//   POST /ledger/v1/name       change my name                                  (signed)
//   POST /ledger/v1/look       my chosen title, hat and skin, by their keys      (signed)
//   GET  /ledger/v1/health
// Signed means headers X-Ledger-Account, X-Ledger-Time (ms) and X-Ledger-Sig = hex HMAC-SHA256(secret, METHOD \n path?query \n time
// \n hex SHA-256 of the body). Requests more than five minutes off the server's clock are refused. Nothing here touches /gtad.

// Versions: this file answers /ledger/v1/ for as long as games that speak v1 exist; a v2 would be a new prefix beside it. Every answer
// carries api and schema; requests' unknown fields are ignored; ids are opaque strings, so keys this server has never heard of are kept.
const API = "v1", SCHEMA = 1;
const PREFIX = "/ledger/v1/", SKEW = 5 * 60 * 1000, MOST = 1e12, MOST_OPS = 64, MOST_IMPORT_CASH = 50_000_000, MOST_BODY = 65536;
const ID = /^[A-Za-z0-9_@.,:+-]{1,64}$/, ACCOUNT = /^a_[0-9a-f]{24}$/, BATCH = /^[A-Za-z0-9_-]{8,64}$/;
const enc = new TextEncoder();

export async function onRequest({ request, env }) {
  try { return await route(request, env); }
  catch (e) { return json({ ok: false, error: "server", why: String(e && e.message || e).slice(0, 200) }, 500); }
}

export async function route(request, env, now = Date.now()) {
  const url = new URL(request.url); const path = url.pathname;
  if (!path.startsWith(PREFIX)) return json({ ok: false, error: "not found" }, 404);
  const what = path.slice(PREFIX.length); const db = env.LEDGER;
  if (what === "health") return json({ ok: true, ledger: !!db });
  if (!db) return json({ ok: false, error: "ledger not set up" }, 503);
  const body = request.method === "POST" ? await request.text() : "";
  if (body.length > MOST_BODY) return json({ ok: false, error: "too big" }, 413);
  if (what === "accounts" && request.method === "POST") return makeAccount(request, env, db, body, now);
  const me = await signedBy(request, db, url, body, now);
  if (!me) return json({ ok: false, error: "unsigned" }, 401);
  await db.prepare("UPDATE accounts SET seen = ? WHERE id = ?").bind(now, me.id).run();
  if (what === "me" && request.method === "GET") return mine(db, me);
  if (what === "world" && request.method === "GET") return world(db);
  if (what === "feed" && request.method === "GET") return feed(db, url);
  if (what === "commit" && request.method === "POST") return commit(db, me, parse(body), now);
  if (what === "import" && request.method === "POST") return importSave(db, me, parse(body), now);
  if (what === "name" && request.method === "POST") return rename(db, me, parse(body), now);
  if (what === "look" && request.method === "POST") return look(db, me, parse(body), now);
  return json({ ok: false, error: "not found" }, 404);
}

// ---------- signing ----------
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export async function hmac(key, s) { const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return hex(await crypto.subtle.sign("HMAC", k, enc.encode(s))); }
export async function signature(secret, method, pathAndQuery, time, body) { return hmac(secret, method + "\n" + pathAndQuery + "\n" + time + "\n" + await sha256(body)); }
function same(a, b) { if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function signedBy(request, db, url, body, now) {
  const id = request.headers.get("X-Ledger-Account"), time = request.headers.get("X-Ledger-Time"), sig = request.headers.get("X-Ledger-Sig");
  if (!id || !ACCOUNT.test(id) || !/^\d{10,16}$/.test(time || "") || !sig) return null;
  if (Math.abs(now - Number(time)) > SKEW) return null;
  const a = await db.prepare("SELECT id, secret, name, cash, imported FROM accounts WHERE id = ?").bind(id).first(); if (!a) return null;
  return same(await signature(a.secret, request.method, url.pathname + url.search, time, body), sig) ? a : null;
}
// The game's token is the one its /gtad updater already carries: worked out from the project's PASSCODE, never stored here.
export const gameToken = async passcode => (await hmac(passcode, "gtad updater v1")).slice(0, 32);

// ---------- accounts ----------
async function makeAccount(request, env, db, body, now) {
  if (!env.PASSCODE) return json({ ok: false, error: "closed" }, 503);
  if (!same(request.headers.get("X-Gtad-Token") || "", await gameToken(env.PASSCODE))) return json({ ok: false, error: "ask Lewis for the link" }, 401);
  const b = parse(body); const name = cleanName(b && b.name); if (!name) return json({ ok: false, error: "bad request", why: "name" }, 400);
  const id = "a_" + hex(crypto.getRandomValues(new Uint8Array(12))), secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare("INSERT INTO accounts (id, secret, name, cash, imported, created, seen) VALUES (?, ?, ?, 0, 0, ?, ?)").bind(id, secret, name, now, now),
    db.prepare("INSERT INTO entries (at, kind, account, why) VALUES (?, 'join', ?, ?)").bind(now, id, name),
  ]);
  return json({ ok: true, account: id, secret, name }, 201);
}
function cleanName(n) { if (typeof n !== "string") return null; n = n.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24); return n.length ? n : null; }
async function rename(db, me, b, now) {
  const name = cleanName(b && b.name); if (!name) return json({ ok: false, error: "bad request", why: "name" }, 400);
  await db.batch([db.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(name, me.id), db.prepare("INSERT INTO entries (at, kind, account, why) VALUES (?, 'name', ?, ?)").bind(now, me.id, name)]);
  return json({ ok: true, name });
}
// The look a player chose, by stable keys: { title, hat, skin }, each a key or null to clear it; a field left out stays as it is.
async function look(db, me, b, now) {
  if (!b || typeof b !== "object") return json({ ok: false, error: "bad request", why: "look" }, 400);
  const set = [], args = [];
  for (const f of ["title", "hat", "skin"]) if (f in b) { const v = b[f]; if (v !== null && (typeof v !== "string" || !ID.test(v))) return json({ ok: false, error: "bad request", why: f }, 400); set.push(f + " = ?"); args.push(v); }
  if (!set.length) return json({ ok: false, error: "bad request", why: "look" }, 400);
  const said = ["title", "hat", "skin"].filter(f => f in b).map(f => f + "=" + (b[f] ?? "")).join(" ");
  await db.batch([db.prepare("UPDATE accounts SET " + set.join(", ") + " WHERE id = ?").bind(...args, me.id), db.prepare("INSERT INTO entries (at, kind, account, why) VALUES (?, 'look', ?, ?)").bind(now, me.id, said)]);
  const a = await db.prepare("SELECT title, hat, skin FROM accounts WHERE id = ?").bind(me.id).first(); return json({ ok: true, ...a });
}

// ---------- reading ----------
async function mine(db, me) {
  const [a, things, unlocks] = await Promise.all([
    db.prepare("SELECT id, name, cash, imported, title, hat, skin FROM accounts WHERE id = ?").bind(me.id).first(),
    db.prepare("SELECT thing, level, paid, since FROM owners WHERE account = ? ORDER BY thing").bind(me.id).all(),
    db.prepare("SELECT unlock, since FROM unlocks WHERE account = ? ORDER BY unlock").bind(me.id).all()]);
  return json({ ok: true, account: a.id, name: a.name, cash: a.cash, imported: !!a.imported, title: a.title, hat: a.hat, skin: a.skin, things: things.results, unlocks: unlocks.results.map(u => u.unlock), seq: await lastSeq(db) });
}
async function world(db) {
  const [accounts, owners] = await Promise.all([
    db.prepare("SELECT id, name, cash, title, hat, skin FROM accounts ORDER BY created").all(),
    db.prepare("SELECT thing, account, level FROM owners ORDER BY thing").all()]);
  return json({ ok: true, accounts: accounts.results, owners: owners.results, seq: await lastSeq(db) });
}
async function feed(db, url) {
  const after = Math.max(0, Math.floor(Number(url.searchParams.get("after")) || 0)), limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)));
  const r = await db.prepare("SELECT seq, at, batch, host, kind, account, other, thing, amount, why FROM entries WHERE seq > ? ORDER BY seq LIMIT ?").bind(after, limit).all();
  return json({ ok: true, entries: r.results, seq: r.results.length ? r.results[r.results.length - 1].seq : after });
}
async function lastSeq(db) { const r = await db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM entries").first(); return r.seq; }

// ---------- commits ----------
// A host's batch: { batch: "<its own id>", ops: [ ... ] }. Every op is checked here for shape, then all of them run as one D1 batch
// (one transaction): a condition that does not hold (money short, a place already owned, not the owner) fails a statement and
// nothing of the batch stays. The batch id is the first row written, so the same batch sent twice is applied once; the repeat is
// answered with the first one's sequence numbers.
const OPS = {
  pay: ["to", "amount"], spend: ["from", "amount"], give: ["from", "to", "amount"],
  buy: ["who", "thing", "price"], sell: ["who", "thing", "price"], upgrade: ["who", "thing", "cost", "level"],
  unlock: ["who", "unlock", "price"], transfer: ["thing", "from", "to"], pass: ["unlock", "from", "to"],
};
function check(op) {
  if (!op || typeof op !== "object" || !OPS[op.op]) return "unknown op";
  for (const f of OPS[op.op]) {
    const v = op[f];
    if (["to", "from", "who"].includes(f)) { if (typeof v !== "string" || !ACCOUNT.test(v)) return f; }
    else if (["thing", "unlock"].includes(f)) { if (typeof v !== "string" || !ID.test(v)) return f; }
    else if (!Number.isSafeInteger(v) || v < 0 || v > MOST || (f === "level" && (v < 1 || v > 9))) return f;
  }
  if (op.why != null && (typeof op.why !== "string" || op.why.length > 80)) return "why";
  if ((op.op === "give" || op.op === "transfer" || op.op === "pass") && op.from === op.to) return "to";
  return null;
}
function statements(db, b, host, op, now) {
  const s = [], E = (kind, account, other, thing, amount) => db.prepare("INSERT INTO entries (at, batch, host, kind, account, other, thing, amount, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(now, b, host, kind, account, other, thing, amount, op.why || null);
  const has = a => db.prepare("INSERT INTO guard (ok, why) SELECT NULL, 'no account' WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?)").bind(a);
  const owns = (a, t) => db.prepare("INSERT INTO guard (ok, why) SELECT NULL, 'not the owner' WHERE NOT EXISTS (SELECT 1 FROM owners WHERE thing = ? AND account = ?)").bind(t, a);
  const cash = (a, d) => db.prepare("UPDATE accounts SET cash = cash + ? WHERE id = ?").bind(d, a);
  switch (op.op) {
    case "pay": s.push(has(op.to), cash(op.to, op.amount), E("pay", op.to, null, null, op.amount)); break;
    case "spend": s.push(has(op.from), cash(op.from, -op.amount), E("spend", op.from, null, null, -op.amount)); break;
    case "give": s.push(has(op.from), has(op.to), cash(op.from, -op.amount), cash(op.to, op.amount), E("give", op.from, op.to, null, -op.amount), E("give", op.to, op.from, null, op.amount)); break;
    case "buy": s.push(has(op.who), cash(op.who, -op.price), db.prepare("INSERT INTO owners (thing, account, level, paid, since) VALUES (?, ?, 0, ?, ?)").bind(op.thing, op.who, op.price, now), E("buy", op.who, null, op.thing, -op.price)); break;
    case "sell": s.push(owns(op.who, op.thing), db.prepare("DELETE FROM owners WHERE thing = ? AND account = ?").bind(op.thing, op.who), cash(op.who, op.price), E("sell", op.who, null, op.thing, op.price)); break;
    case "upgrade": s.push(owns(op.who, op.thing),
      db.prepare("INSERT INTO guard (ok, why) SELECT NULL, 'wrong level' WHERE NOT EXISTS (SELECT 1 FROM owners WHERE thing = ? AND level = ?)").bind(op.thing, op.level - 1),
      cash(op.who, -op.cost), db.prepare("UPDATE owners SET level = ?, paid = paid + ? WHERE thing = ? AND account = ?").bind(op.level, op.cost, op.thing, op.who), E("upgrade", op.who, null, op.thing, -op.cost)); break;
    case "unlock": s.push(has(op.who), cash(op.who, -op.price), db.prepare("INSERT INTO unlocks (account, unlock, since) VALUES (?, ?, ?)").bind(op.who, op.unlock, now), E("unlock", op.who, null, op.unlock, -op.price)); break;
    case "transfer": s.push(has(op.to), owns(op.from, op.thing), db.prepare("UPDATE owners SET account = ?, since = ? WHERE thing = ? AND account = ?").bind(op.to, now, op.thing, op.from), E("transfer", op.from, op.to, op.thing, 0), E("transfer", op.to, op.from, op.thing, 0)); break;
    case "pass": s.push(has(op.to),
      db.prepare("INSERT INTO guard (ok, why) SELECT NULL, 'not theirs' WHERE NOT EXISTS (SELECT 1 FROM unlocks WHERE account = ? AND unlock = ?)").bind(op.from, op.unlock),
      db.prepare("DELETE FROM unlocks WHERE account = ? AND unlock = ?").bind(op.from, op.unlock), db.prepare("INSERT INTO unlocks (account, unlock, since) VALUES (?, ?, ?)").bind(op.to, op.unlock, now),
      E("pass", op.from, op.to, op.unlock, 0), E("pass", op.to, op.from, op.unlock, 0)); break;
  }
  return s;
}
async function commit(db, host, b, now) {
  if (!b || typeof b.batch !== "string" || !BATCH.test(b.batch) || !Array.isArray(b.ops) || !b.ops.length || b.ops.length > MOST_OPS) return json({ ok: false, error: "bad request", why: "batch" }, 400);
  for (let i = 0; i < b.ops.length; i++) { const bad = check(b.ops[i]); if (bad) return json({ ok: false, error: "bad request", op: i, why: bad }, 400); }
  const id = host.id + ":" + b.batch;                         // batch ids are the host's own; two hosts may pick the same one
  const before = await answer(db, id); if (before) return before;
  const list = [db.prepare("INSERT INTO batches (id, host, at, first_seq, entries) VALUES (?, ?, ?, NULL, 0)").bind(id, host.id, now)];
  for (const op of b.ops) list.push(...statements(db, id, host.id, op, now));
  list.push(db.prepare("UPDATE batches SET first_seq = (SELECT MIN(seq) FROM entries WHERE batch = ?), entries = (SELECT COUNT(*) FROM entries WHERE batch = ?) WHERE id = ?").bind(id, id, id));
  try { await db.batch(list); }
  catch (e) {
    const again = await answer(db, id); if (again) return again;      // the same batch landed meanwhile from a retry
    return json({ ok: false, error: "conflict", ...(await why(db, b.ops)) }, 409);
  }
  return answer(db, id, true);
}
async function answer(db, id, fresh = false) {
  const r = await db.prepare("SELECT first_seq, entries FROM batches WHERE id = ?").bind(id).first(); if (!r) return null;
  return json({ ok: true, repeat: !fresh, first: r.first_seq, entries: r.entries, seq: await lastSeq(db) }, fresh ? 201 : 200);
}
// Why a batch failed: walk its ops against the books as they are now, keeping track of what the earlier ops would have done.
async function why(db, ops) {
  const cash = {}, own = {}, unl = {};
  const money = async a => { if (!(a in cash)) { const r = await db.prepare("SELECT cash FROM accounts WHERE id = ?").bind(a).first(); cash[a] = r ? r.cash : null; } return cash[a]; };
  const owner = async t => { if (!(t in own)) { const r = await db.prepare("SELECT account, level FROM owners WHERE thing = ?").bind(t).first(); own[t] = r ? { account: r.account, level: r.level } : null; } return own[t]; };
  const hasU = async (a, u) => { const k = a + "|" + u; if (!(k in unl)) unl[k] = !!(await db.prepare("SELECT 1 AS x FROM unlocks WHERE account = ? AND unlock = ?").bind(a, u).first()); return unl[k]; };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i], fail = (w, extra = {}) => ({ op: i, why: w, ...extra });
    for (const a of [o.to, o.from, o.who].filter(Boolean)) if ((await money(a)) === null) return fail("no account", { account: a });
    const debit = async (a, n) => { if ((await money(a)) < n) return true; cash[a] -= n; return false; };
    if (o.op === "pay") cash[o.to] += o.amount;
    else if (o.op === "spend") { if (await debit(o.from, o.amount)) return fail("short", { account: o.from, need: o.amount, has: cash[o.from] }); }
    else if (o.op === "give") { if (await debit(o.from, o.amount)) return fail("short", { account: o.from, need: o.amount, has: cash[o.from] }); cash[o.to] += o.amount; }
    else if (o.op === "buy") { const w = await owner(o.thing); if (w) return fail("owned", { thing: o.thing, owner: w.account }); if (await debit(o.who, o.price)) return fail("short", { account: o.who, need: o.price, has: cash[o.who] }); own[o.thing] = { account: o.who, level: 0 }; }
    else if (o.op === "sell") { const w = await owner(o.thing); if (!w || w.account !== o.who) return fail("not the owner", { thing: o.thing }); own[o.thing] = null; cash[o.who] += o.price; }
    else if (o.op === "upgrade") { const w = await owner(o.thing); if (!w || w.account !== o.who) return fail("not the owner", { thing: o.thing }); if (w.level !== o.level - 1) return fail("wrong level", { thing: o.thing, level: w.level }); if (await debit(o.who, o.cost)) return fail("short", { account: o.who, need: o.cost, has: cash[o.who] }); w.level = o.level; }
    else if (o.op === "unlock") { if (await hasU(o.who, o.unlock)) return fail("has it", { unlock: o.unlock }); if (await debit(o.who, o.price)) return fail("short", { account: o.who, need: o.price, has: cash[o.who] }); unl[o.who + "|" + o.unlock] = true; }
    else if (o.op === "transfer") { const w = await owner(o.thing); if (!w || w.account !== o.from) return fail("not the owner", { thing: o.thing }); w.account = o.to; }
    else if (o.op === "pass") { if (!(await hasU(o.from, o.unlock))) return fail("not theirs", { unlock: o.unlock }); if (await hasU(o.to, o.unlock)) return fail("has it", { unlock: o.unlock }); unl[o.from + "|" + o.unlock] = false; unl[o.to + "|" + o.unlock] = true; }
  }
  return { why: "changed meanwhile" };                         // the books moved between the batch and this look: send it again
}

// ---------- a local save, once ----------
// { cash, things: [{ thing, level, paid }], unlocks: [id] }. Places someone already owns in the global town stay theirs; the
// answer lists them. The account's cash goes up by the save's cash (capped), and the account is marked so it never happens again.
async function importSave(db, me, b, now) {
  if (!b || !Number.isSafeInteger(b.cash) || b.cash < 0 || !Array.isArray(b.things || []) || !Array.isArray(b.unlocks || [])) return json({ ok: false, error: "bad request", why: "save" }, 400);
  const things = (b.things || []).filter(t => t && typeof t.thing === "string" && ID.test(t.thing)).slice(0, 200), unlocks = (b.unlocks || []).filter(u => typeof u === "string" && ID.test(u)).slice(0, 200);
  if (me.imported) return json({ ok: false, error: "already imported" }, 409);
  const cash = Math.min(b.cash, MOST_IMPORT_CASH);
  const list = [
    db.prepare("INSERT INTO guard (ok, why) SELECT NULL, 'already imported' WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND imported = 1)").bind(me.id),
    db.prepare("UPDATE accounts SET imported = 1, cash = cash + ? WHERE id = ?").bind(cash, me.id),
    db.prepare("INSERT INTO entries (at, kind, account, amount, why) VALUES (?, 'import', ?, ?, 'cash from the local save')").bind(now, me.id, cash)];
  for (const t of things) {
    const level = Number.isSafeInteger(t.level) ? Math.min(9, Math.max(0, t.level)) : 0, paid = Number.isSafeInteger(t.paid) ? Math.min(MOST, Math.max(0, t.paid)) : 0;
    list.push(db.prepare("INSERT OR IGNORE INTO owners (thing, account, level, paid, since) VALUES (?, ?, ?, ?, ?)").bind(t.thing, me.id, level, paid, now),
      db.prepare("INSERT INTO entries (at, kind, account, thing, why) SELECT ?, 'import', ?, ?, 'place from the local save' WHERE EXISTS (SELECT 1 FROM owners WHERE thing = ? AND account = ? AND since = ?)").bind(now, me.id, t.thing, t.thing, me.id, now));
  }
  for (const u of unlocks) list.push(db.prepare("INSERT OR IGNORE INTO unlocks (account, unlock, since) VALUES (?, ?, ?)").bind(me.id, u, now));
  try { await db.batch(list); } catch (e) { return json({ ok: false, error: "already imported" }, 409); }
  const got = (await db.prepare("SELECT thing FROM owners WHERE account = ?").bind(me.id).all()).results.map(r => r.thing);
  return json({ ok: true, cash, kept: things.map(t => t.thing).filter(t => got.includes(t)), taken: things.map(t => t.thing).filter(t => !got.includes(t)) });
}

function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function json(o, status = 200) { return new Response(JSON.stringify({ api: API, schema: SCHEMA, ...o }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
