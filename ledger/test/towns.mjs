// /gtad/towns in process, against a bucket kept in memory: node ledger/test/towns.mjs
import assert from "node:assert/strict";
import { onRequest, updaterToken } from "../../functions/gtad/[[path]].js";
const store = new Map();
const BUCKET = {
  put: async (k, v) => { store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v)); },
  get: async k => store.has(k) ? { text: async () => store.get(k) } : null,
  delete: async k => { for (const x of [].concat(k)) store.delete(x); },
  list: async ({ prefix }) => ({ objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }),
};
const env = { PASSCODE: "test-code", BUCKET }, tok = await updaterToken("test-code"), next = async () => new Response("page");
let ip = 0;
async function call(method, query = "", body, headers = {}, cf = { region: "California", country: "US", city: "South Pasadena" }) {
  const r = new Request("https://x.test/gtad/towns" + query, { method, headers: { "CF-Connecting-IP": "10.0.0." + (++ip % 200), ...headers }, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  Object.defineProperty(r, "cf", { value: cf }); return onRequest({ request: r, env, next });
}
const T = { "X-Gtad-Token": tok }, town = { town: "29b91774", host: "Lewis", players: 2, max: 12, build: "0.12.4 (abc1234)", protocol: 12, code: "7R8CFN" };

assert.equal((await call("GET")).status, 401, "no token, no list");
assert.equal((await call("POST", "", town)).status, 401, "no token, no town");
assert.equal((await call("GET", "?t=wrong")).status, 401, "a wrong token");
let r = await call("POST", "", town, T); assert.equal(r.status, 204);
const kept = JSON.parse(store.get("towns/29b91774.json")); assert.equal(kept.region, "California"); assert.equal(kept.country, "US");
assert.ok(!("city" in kept) && !JSON.stringify(kept).includes("10.0.0."), "no city, no address");
r = await call("GET", "?t=" + tok); assert.equal(r.status, 200); assert.equal(r.headers.get("Cache-Control"), "no-store");
let l = (await r.json()).towns; assert.equal(l.length, 1); assert.deepEqual(Object.keys(l[0]).sort(), ["age", "build", "code", "country", "host", "max", "players", "protocol", "region", "town"]); assert.equal(l[0].age, 0);
assert.equal((await call("POST", "", { ...town, players: 3 }, T)).status, 204, "a heartbeat");
l = (await (await call("GET", "", null, T)).json()).towns; assert.equal(l.length, 1); assert.equal(l[0].players, 3, "the heartbeat replaced it");
for (const [k, v] of [["town", "29B91774"], ["town", "1234567"], ["host", ""], ["host", "x".repeat(17)], ["host", "a\nb"], ["players", 0], ["players", 13], ["max", 2.5], ["build", "x".repeat(41)], ["build", "café"], ["protocol", "12"], ["code", "7r8cfn"], ["code", "7R8CF"]]) {
  r = await call("POST", "", { ...town, [k]: v }, T); assert.equal(r.status, 400, k + " " + JSON.stringify(v)); assert.equal((await r.json()).why, k);
}
assert.equal((await call("POST", "", "{not json", T)).status, 400);
assert.equal((await call("POST", "", JSON.stringify({ ...town, pad: "x".repeat(2100) }), T)).status, 413, "over 2 KB");
// one heard from 61 s ago is left out and deleted
store.set("towns/aaaaaaaa.json", JSON.stringify({ ...town, town: "aaaaaaaa", region: "", country: "", seen: Date.now() - 61000 }));
store.set("towns/bbbbbbbb.json", JSON.stringify({ ...town, town: "bbbbbbbb", region: "", country: "", seen: Date.now() - 30000 }));
l = (await (await call("GET", "", null, T)).json()).towns; assert.deepEqual(l.map(x => x.town), ["29b91774", "bbbbbbbb"]); assert.equal(l[1].age, 30);
assert.ok(!store.has("towns/aaaaaaaa.json"), "the stale one is deleted");
assert.equal((await call("DELETE", "?town=29b91774", null, T)).status, 204); assert.ok(!store.has("towns/29b91774.json"));
assert.equal((await call("DELETE", "?town=29b91774", null, T)).status, 204, "204 even if missing");
assert.equal((await call("DELETE", "?town=nope", null, T)).status, 400);
assert.equal((await call("PUT", "", town, T)).status, 405);
// never served by any other path
const g = new Request("https://x.test/gtad/towns/bbbbbbbb.json"); assert.equal((await onRequest({ request: g, env, next })).status, 404);
// the light limit: 120 a minute from one address, the address itself never kept
let last; for (let i = 0; i < 121; i++) last = await call("GET", "", null, { ...T, "CF-Connecting-IP": "10.9.9.9" }); assert.equal(last.status, 429);
assert.ok(![...store.values()].some(v => v.includes("10.9.9.9")));
console.log("TOWNS ok");
