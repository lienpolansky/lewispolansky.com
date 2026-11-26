// The same story against a running ledger (wrangler pages dev with a local D1, or the real site):
//   LEDGER_URL=http://127.0.0.1:8788 LEDGER_CODE=<the /gtad code> node ledger/test/live.mjs
// Makes four throwaway accounts, so run it on production only on purpose.
import assert from "node:assert/strict";
import { signature, gameToken } from "../../functions/ledger/[[path]].js";
const BASE = process.env.LEDGER_URL, CODE = process.env.LEDGER_CODE; if (!BASE || !CODE) throw new Error("set LEDGER_URL and LEDGER_CODE");
async function call(method, path, body, who, headers = {}) {
  const text = body == null ? "" : JSON.stringify(body), h = { "Content-Type": "application/json", ...headers };
  if (who) { const t = String(Date.now()); h["X-Ledger-Account"] = who.account; h["X-Ledger-Time"] = t; h["X-Ledger-Sig"] = await signature(who.secret, method, path, t, text); }
  const r = await fetch(BASE + path, { method, headers: h, body: method === "POST" ? text : undefined }); return { status: r.status, ...(await r.json()) };
}
const join = async n => { const r = await call("POST", "/ledger/v1/accounts", { name: n }, null, { "X-Gtad-Token": await gameToken(CODE) }); assert.equal(r.status, 201, JSON.stringify(r)); return r; };
const run = Date.now().toString(36);
const A = await join("Live host A"), B = await join("Live host B"), leo = await join("Live Leo"), sam = await join("Live Sam");
assert.equal((await call("POST", "/ledger/v1/commit", { batch: "seed-" + run, ops: [{ op: "pay", to: leo.account, amount: 600000 }, { op: "pay", to: sam.account, amount: 600000 }] }, A)).status, 201);
const thing = "test-hall-" + run;
const [x, y] = await Promise.all([
  call("POST", "/ledger/v1/commit", { batch: "hall-" + run, ops: [{ op: "buy", who: leo.account, thing, price: 540000 }] }, A),
  call("POST", "/ledger/v1/commit", { batch: "hall-" + run, ops: [{ op: "buy", who: sam.account, thing, price: 540000 }] }, B)]);
assert.deepEqual([x.status, y.status].sort(), [201, 409], JSON.stringify([x, y]));
const r = await call("POST", "/ledger/v1/commit", { batch: "bad-" + run, ops: [{ op: "pay", to: leo.account, amount: 1 }, { op: "spend", from: sam.account, amount: 10_000_000 }] }, A);
assert.equal(r.status, 409); assert.equal(r.why, "short");
const l = await call("GET", "/ledger/v1/me", null, leo), s = await call("GET", "/ledger/v1/me", null, sam);
assert.equal(l.cash + s.cash, 600000 + 60000, "only one paid for the hall, and the failed batch left no trace");
const again = await call("POST", "/ledger/v1/commit", { batch: "seed-" + run, ops: [{ op: "pay", to: leo.account, amount: 600000 }] }, A);
assert.equal(again.status, 200); assert.equal(again.repeat, true);
console.log("LIVE ok:", BASE, "hall went to", x.status === 201 ? "Leo" : "Sam");
