// Offline tests for functions/ledger: node --test ledger/test   (Node 22.5 or newer; no packages, no network)
// D1 is stood in for by Node's own SQLite with D1's rules: a batch is one transaction, and a failing statement undoes all of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { route, signature, gameToken } from "../../functions/ledger/[[path]].js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.db, this.sql, a); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  now() { return this.db.prepare(this.sql).run(...this.args); }
}
function d1() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON;"); db.exec(SCHEMA);
  return { raw: db, prepare: sql => new Stmt(db, sql), async batch(list) {
    db.exec("BEGIN"); try { const out = list.map(s => s.now()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
}
const PASS = "test-code";
function town() {
  const env = { LEDGER: d1(), PASSCODE: PASS }; let clock = 1_800_000_000_000;
  const call = async (method, path, body, who, opts = {}) => {
    const text = body == null ? "" : JSON.stringify(body), headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (who) { const t = String(opts.time ?? clock); headers["X-Ledger-Account"] = who.account; headers["X-Ledger-Time"] = t; headers["X-Ledger-Sig"] = opts.sig ?? await signature(who.secret, method, path, t, text); }
    const res = await route(new Request("https://lewispolansky.com" + path, { method, headers, body: method === "POST" ? text : undefined }), env, clock++);
    return { status: res.status, ...(await res.json()) };
  };
  const join = async name => { const r = await call("POST", "/ledger/v1/accounts", { name }, null, { headers: { "X-Gtad-Token": await gameToken(PASS) } }); assert.equal(r.status, 201); return r; };
  const commit = (host, batch, ops) => call("POST", "/ledger/v1/commit", { batch, ops }, host);
  const me = who => call("GET", "/ledger/v1/me", null, who);
  return { env, call, join, commit, me };
}

test("an account needs the game's token, and gets its id and secret once", async () => {
  const t = town();
  assert.equal((await t.call("POST", "/ledger/v1/accounts", { name: "Leo" })).status, 401);
  assert.equal((await t.call("POST", "/ledger/v1/accounts", { name: "Leo" }, null, { headers: { "X-Gtad-Token": "nope" } })).status, 401);
  const leo = await t.join("Leo"); assert.match(leo.account, /^a_[0-9a-f]{24}$/); assert.match(leo.secret, /^[0-9a-f]{64}$/);
  const m = await t.me(leo); assert.equal(m.ok, true); assert.equal(m.cash, 0); assert.equal(m.name, "Leo");
});

test("signatures: a wrong one, an old one and another account's secret are refused", async () => {
  const t = town(); const leo = await t.join("Leo"), sam = await t.join("Sam");
  assert.equal((await t.call("GET", "/ledger/v1/me", null, leo, { sig: "0".repeat(64) })).status, 401);
  assert.equal((await t.call("GET", "/ledger/v1/me", null, leo, { time: 1_700_000_000_000 })).status, 401);
  assert.equal((await t.call("GET", "/ledger/v1/me", null, { account: leo.account, secret: sam.secret })).status, 401);
  assert.equal((await t.call("GET", "/ledger/v1/health")).ok, true);
});

test("pay, buy, upgrade and sell move cash and ownership, and write the ledger", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo");
  let r = await t.commit(host, "job-0001", [{ op: "pay", to: leo.account, amount: 30000, why: "cake to Mission St" }]); assert.equal(r.status, 201);
  r = await t.commit(host, "buy-0001", [{ op: "buy", who: leo.account, thing: "b018", price: 19500 }, { op: "upgrade", who: leo.account, thing: "b018", cost: 2000, level: 1 }]); assert.equal(r.status, 201);
  let m = await t.me(leo); assert.equal(m.cash, 30000 - 19500 - 2000); assert.deepEqual(m.things.map(x => [x.thing, x.level, x.paid]), [["b018", 1, 21500]]);
  r = await t.commit(host, "sell-0001", [{ op: "sell", who: leo.account, thing: "b018", price: 12000 }]); assert.equal(r.status, 201);
  m = await t.me(leo); assert.equal(m.cash, 8500 + 12000); assert.equal(m.things.length, 0);
  const f = await t.call("GET", "/ledger/v1/feed?after=0&limit=50", null, leo);
  assert.deepEqual(f.entries.filter(e => e.account === leo.account).map(e => e.kind), ["join", "pay", "buy", "upgrade", "sell"]);
  assert.throws(() => t.env.LEDGER.raw.exec("UPDATE entries SET amount = 1"), /append only/);
  assert.throws(() => t.env.LEDGER.raw.exec("DELETE FROM entries"), /append only/);
});

test("two hosts buy City Hall at the same moment: exactly one gets it, the other pays nothing", async () => {
  const t = town(); const hostA = await t.join("Host A"), hostB = await t.join("Host B"), leo = await t.join("Leo"), sam = await t.join("Sam");
  await t.commit(hostA, "seed-000a", [{ op: "pay", to: leo.account, amount: 600000 }]); await t.commit(hostB, "seed-000b", [{ op: "pay", to: sam.account, amount: 600000 }]);
  const [a, b] = await Promise.all([
    t.commit(hostA, "hall-0001", [{ op: "buy", who: leo.account, thing: "b113", price: 540000 }]),
    t.commit(hostB, "hall-0001", [{ op: "buy", who: sam.account, thing: "b113", price: 540000 }])]);
  const won = [a, b].filter(x => x.status === 201), lost = [a, b].filter(x => x.status === 409);
  assert.equal(won.length, 1); assert.equal(lost.length, 1); assert.equal(lost[0].why, "owned"); assert.equal(lost[0].thing, "b113");
  const w = await t.call("GET", "/ledger/v1/world", null, leo); const hall = w.owners.filter(o => o.thing === "b113"); assert.equal(hall.length, 1);
  const winner = hall[0].account, loser = winner === leo.account ? sam.account : leo.account;
  assert.equal(w.accounts.find(x => x.id === winner).cash, 60000); assert.equal(w.accounts.find(x => x.id === loser).cash, 600000);
});

test("a batch is all or nothing: a trade with one bad leg leaves both sides as they were", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo"), sam = await t.join("Sam");
  await t.commit(host, "seed-0001", [{ op: "pay", to: leo.account, amount: 50000 }, { op: "pay", to: sam.account, amount: 1000 }, { op: "buy", who: leo.account, thing: "h261", price: 0 }]);
  const r = await t.commit(host, "trade-001", [
    { op: "transfer", thing: "h261", from: leo.account, to: sam.account },
    { op: "give", from: sam.account, to: leo.account, amount: 5000 }]);               // Sam has only 1000
  assert.equal(r.status, 409); assert.equal(r.why, "short"); assert.equal(r.op, 1);
  const l = await t.me(leo), s = await t.me(sam);
  assert.deepEqual(l.things.map(x => x.thing), ["h261"]); assert.equal(l.cash, 50000); assert.equal(s.cash, 1000); assert.equal(s.things.length, 0);
  const ok = await t.commit(host, "trade-002", [{ op: "transfer", thing: "h261", from: leo.account, to: sam.account }, { op: "give", from: sam.account, to: leo.account, amount: 1000 }]);
  assert.equal(ok.status, 201); assert.deepEqual((await t.me(sam)).things.map(x => x.thing), ["h261"]); assert.equal((await t.me(leo)).cash, 51000);
});

test("the same batch sent twice is applied once, and the repeat gets the first answer", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo");
  const a = await t.commit(host, "pay-retry1", [{ op: "pay", to: leo.account, amount: 700 }]);
  const b = await t.commit(host, "pay-retry1", [{ op: "pay", to: leo.account, amount: 700 }]);
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.repeat, true); assert.equal(b.first, a.first);
  assert.equal((await t.me(leo)).cash, 700);
  const [c, d] = await Promise.all([t.commit(host, "pay-retry2", [{ op: "pay", to: leo.account, amount: 5 }]), t.commit(host, "pay-retry2", [{ op: "pay", to: leo.account, amount: 5 }])]);
  assert.deepEqual([c.status, d.status].sort(), [200, 201]); assert.equal((await t.me(leo)).cash, 705);
  const other = await t.join("Other host");                                          // another host's batch with the same name is its own
  assert.equal((await t.commit(other, "pay-retry1", [{ op: "pay", to: leo.account, amount: 1 }])).status, 201);
});

test("refusals say why: not the owner, wrong level, has it, no account, bad shapes", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo"), sam = await t.join("Sam");
  await t.commit(host, "seed-0001", [{ op: "pay", to: leo.account, amount: 100000 }, { op: "buy", who: leo.account, thing: "c01", price: 1000 }, { op: "unlock", who: leo.account, unlock: "car_van", price: 500 }]);
  assert.equal((await t.commit(host, "x-000001", [{ op: "sell", who: sam.account, thing: "c01", price: 1 }])).why, "not the owner");
  assert.equal((await t.commit(host, "x-000002", [{ op: "upgrade", who: leo.account, thing: "c01", cost: 1, level: 2 }])).why, "wrong level");
  assert.equal((await t.commit(host, "x-000003", [{ op: "unlock", who: leo.account, unlock: "car_van", price: 1 }])).why, "has it");
  assert.equal((await t.commit(host, "x-000004", [{ op: "pay", to: "a_" + "0".repeat(24), amount: 1 }])).why, "no account");
  assert.equal((await t.commit(host, "x-000005", [{ op: "pay", to: leo.account, amount: -5 }])).status, 400);
  assert.equal((await t.commit(host, "x-000006", [{ op: "rob", who: leo.account }])).status, 400);
  assert.equal((await t.commit(host, "x", [{ op: "pay", to: leo.account, amount: 1 }])).status, 400);
  const p = await t.commit(host, "x-000007", [{ op: "pass", unlock: "car_van", from: leo.account, to: sam.account }]); assert.equal(p.status, 201);
  assert.deepEqual((await t.me(sam)).unlocks, ["car_van"]); assert.deepEqual((await t.me(leo)).unlocks, []);
  assert.equal((await t.me(leo)).cash, 100000 - 1000 - 500);
});

test("a local save comes in once; places someone already owns stay theirs", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo"), sam = await t.join("Sam");
  await t.commit(host, "seed-0001", [{ op: "pay", to: sam.account, amount: 50000 }, { op: "buy", who: sam.account, thing: "c04", price: 20000 }]);
  const r = await t.call("POST", "/ledger/v1/import", { cash: 123456, things: [{ thing: "c04", level: 2, paid: 9 }, { thing: "h261", level: 0, paid: 0 }], unlocks: ["car_pickup", "paint_teal"] }, leo);
  assert.equal(r.ok, true); assert.deepEqual(r.kept, ["h261"]); assert.deepEqual(r.taken, ["c04"]);
  const m = await t.me(leo); assert.equal(m.cash, 123456); assert.equal(m.imported, true); assert.deepEqual(m.unlocks, ["car_pickup", "paint_teal"]);
  assert.equal((await t.call("POST", "/ledger/v1/import", { cash: 999, things: [], unlocks: [] }, leo)).status, 409);
  assert.equal((await t.me(leo)).cash, 123456);
  const big = await t.join("Big"); assert.equal((await t.call("POST", "/ledger/v1/import", { cash: 9e12, things: [], unlocks: [] }, big)).cash, 50_000_000);
});

test("names are cleaned and kept short", async () => {
  const t = town(); const leo = await t.join("  Leo\u0007 the very long name that keeps going  ");
  assert.equal(leo.name, "Leo the very long name t"); const r = await t.call("POST", "/ledger/v1/name", { name: "Mayor Leo" }, leo); assert.equal(r.name, "Mayor Leo");
  assert.equal((await t.call("POST", "/ledger/v1/name", { name: "   " }, leo)).status, 400);
});

test("version-proof: answers carry api and schema, unknown fields are ignored, unknown keys are kept", async () => {
  const t = town(); const host = await t.join("Host"), leo = await t.join("Leo");
  const m = await t.me(leo); assert.equal(m.api, "v1"); assert.equal(m.schema, 1);
  const r = await t.call("POST", "/ledger/v1/commit", { batch: "fut-00001", ops: [{ op: "pay", to: leo.account, amount: 10, sparkle: true }], from_v9: { x: 1 } }, host);
  assert.equal(r.status, 201); assert.equal((await t.me(leo)).cash, 10);
  const l = await t.call("POST", "/ledger/v1/look", { title: "a_title_from_a_later_version", hat: "cowboy", glow: "blue" }, leo);
  assert.equal(l.ok, true); assert.equal(l.title, "a_title_from_a_later_version"); assert.equal(l.hat, "cowboy"); assert.equal(l.skin, null);
  await t.call("POST", "/ledger/v1/look", { skin: "skin_03" }, leo);                     // a field left out stays as it was
  const w = await t.call("GET", "/ledger/v1/world", null, leo); const me = w.accounts.find(a => a.id === leo.account);
  assert.deepEqual([me.title, me.hat, me.skin], ["a_title_from_a_later_version", "cowboy", "skin_03"]);
  assert.equal((await t.call("POST", "/ledger/v1/look", { title: 7 }, leo)).status, 400);
  const rows = t.env.LEDGER.raw.prepare("SELECT DISTINCT sv FROM entries UNION SELECT DISTINCT sv FROM accounts").all().map(x => x.sv); assert.deepEqual(rows, [1]);
  assert.equal(t.env.LEDGER.raw.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, "1");
  const cols = t.env.LEDGER.raw.prepare("SELECT name FROM pragma_table_info('owners')").all().map(c => c.name);
  for (const bad of ["x", "y", "z", "pos", "rot", "yaw", "speed"]) assert.ok(!cols.includes(bad), "no positions or physics in the ledger");
});
