import assert from "node:assert/strict";
import test from "node:test";
import { JobStore } from "../service/jobs.mjs";
import { createHandler, validateRequest } from "../service/server.mjs";

const hash = "0x" + "ab".repeat(32);
const request = { hash, chain: "l1", chainIds: { l1: "100", l2: "200" } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runner() {
  const calls = [];
  return { calls, run(input, progress) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const call = { input, progress, resolve, reject, cancelled: false };
    calls.push(call);
    return { promise, cancel() { call.cancelled = true; reject(Object.assign(new Error("Cancelled"), { code: "cancelled" })); } };
  } };
}
function result(partial = false) { return { json: JSON.stringify({ apiVersion: 1, partial }), partial }; }

test("viewers share a decode, but cancelling one viewer preserves another's work", async t => {
  const fake = runner(), store = new JobStore(fake.run);
  t.after(() => store.close());
  const first = store.create(request), second = store.create(request);
  await tick();
  assert.equal(fake.calls.length, 1);
  assert.notEqual(first.id, second.id);
  store.release(first.id);
  assert.equal(fake.calls[0].cancelled, false);
  fake.calls[0].progress("Matching calls");
  assert.equal(store.status(second.id).progress, "Matching calls");
  fake.calls[0].resolve(result());
  await tick();
  assert.equal(store.status(second.id).state, "complete");
  assert.equal(JSON.parse(store.result(second.id)).apiVersion, 1);
});

test("cancelling the last viewer stops the worker and allows queued work to start", async t => {
  const fake = runner(), store = new JobStore(fake.run, { concurrency: 1 });
  t.after(() => store.close());
  const first = store.create(request), next = store.create({ ...request, chain: "l2" });
  await tick();
  assert.equal(store.status(next.id).state, "queued");
  store.release(first.id);
  await tick();
  assert.equal(fake.calls[0].cancelled, true);
  assert.equal(fake.calls.length, 2);
  assert.equal(store.status(next.id).state, "running");
});

test("cache entries are scoped by chain IDs and fresh requests bypass completed snapshots", async t => {
  const fake = runner(), store = new JobStore(fake.run);
  t.after(() => store.close());
  const first = store.create(request);
  await tick(); fake.calls[0].resolve(result()); await tick();
  store.release(first.id);
  assert.equal(store.create(request).state, "complete");
  store.create({ ...request, refresh: true });
  store.create({ ...request, chainIds: { l1: "10200", l2: "201" } });
  await tick();
  assert.equal(fake.calls.length, 3);
});

test("partial snapshots expire quickly and abandoned leases release their worker", async t => {
  let now = 0;
  const fake = runner(), store = new JobStore(fake.run, { now: () => now, partialCacheMs: 5, leaseMs: 20 });
  t.after(() => store.close());
  const first = store.create(request);
  await tick(); fake.calls[0].resolve(result(true)); await tick();
  store.release(first.id); now = 6;
  const second = store.create(request);
  await tick(); assert.equal(fake.calls.length, 2);
  now = 27; store.sweep();
  assert.equal(fake.calls[1].cancelled, true);
  assert.throws(() => store.status(second.id), /expired/);
});

test("limits reject excess work and oversized results without exposing provider messages", async t => {
  const fake = runner(), store = new JobStore(fake.run, { maxJobs: 1, maxClients: 2, maxResultBytes: 2 });
  t.after(() => store.close());
  const first = store.create(request);
  assert.throws(() => store.create({ ...request, chain: "l2" }), /queue is full/);
  await tick(); fake.calls[0].resolve(result()); await tick();
  assert.equal(store.status(first.id).errorCode, "result-limit");
  store.release(first.id);
  const next = store.create(request);
  await tick();
  fake.calls[1].reject(new Error("provider https://secret-key.test/?apikey=private"));
  await tick();
  assert.equal(store.status(next.id).state, "failed");
  assert.ok(!JSON.stringify(store.status(next.id)).includes("private"));
  assert.ok(!JSON.stringify(store.status(next.id)).includes("secret-key"));
});

test("requests accept network identity, never caller-supplied RPC endpoints", () => {
  assert.deepEqual(validateRequest(request), { ...request, refresh: false });
  for (const body of [{ ...request, l1Rpc: "https://other.test" }, { ...request, hash: [hash] },
    { ...request, chainIds: { l1: "100", l2: "0" } }, { ...request, refresh: "yes" }, { ...request, chain: "L1" }]) {
    assert.throws(() => validateRequest(body));
  }
});

async function invoke(handler, { method = "GET", url = "/api/health", headers = {}, body = "" } = {}) {
  const req = { method, url, headers: { host: "dashboard.test", ...headers }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  const response = { status: null, headers: {}, body: "", headersSent: false,
    writeHead(status, values) { this.status = status; this.headers = values || {}; this.headersSent = true; },
    end(value = "") { this.body = value; },
  };
  await handler(req, response);
  return response;
}
test("HTTP contract supports jobs, results, and release through a same-origin proxy", async t => {
  const fake = runner(), store = new JobStore(fake.run);
  t.after(() => store.close());
  const handler = createHandler(store);
  assert.equal((await invoke(handler)).status, 200);
  const started = await invoke(handler, { method: "POST", url: "/api/jobs",
    headers: { "content-type": "application/json", origin: "https://dashboard.test" }, body: JSON.stringify(request) });
  assert.equal(started.status, 202);
  const id = JSON.parse(started.body).id;
  await tick(); fake.calls[0].resolve(result()); await tick();
  assert.equal((await invoke(handler, { url: "/api/jobs/" + id + "/result" })).body, result().json);
  assert.equal((await invoke(handler, { method: "DELETE", url: "/api/jobs/" + id })).status, 204);
  assert.equal((await invoke(handler, { url: "/api/jobs/" + id })).status, 404);
});
test("HTTP errors reject cross-site, oversized, and malformed requests", async t => {
  const fake = runner(), store = new JobStore(fake.run);
  t.after(() => store.close());
  const handler = createHandler(store), post = { method: "POST", url: "/api/jobs" };
  assert.equal((await invoke(handler, post)).status, 415);
  assert.equal((await invoke(handler, { ...post, headers: { origin: "https://other.test" } })).status, 403);
  assert.equal((await invoke(handler, { ...post, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await invoke(handler, { ...post, headers: { "content-type": "application/json", "content-length": "9999" } })).status, 413);
  assert.equal((await invoke(handler, { ...post, headers: { "content-type": "application/json" }, body: "bad" })).status, 400);
  assert.equal((await invoke(createHandler(store, { configured: false }))).status, 503);
});
