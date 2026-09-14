import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8");
function fixture({ unavailable = false, blocked = false } = {}) {
  const elements = new Map(), sockets = [], requests = [], timeouts = new Map(), intervals = new Map(), events = {};
  let timer = 0;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", value: "", dataset: {},
      disabled: false, classList: { toggle() {} }, addEventListener() {}, append() {},
      replaceChildren() {}, querySelector() { return element(id + "-submit"); }, scrollIntoView() {} });
    return elements.get(id);
  };
  class FakeSocket {
    constructor(url) {
      if (FakeSocket.blocked) throw new Error("WebSocket blocked");
      this.url = String(url);
      sockets.push(this);
    }
    close() { if (!this.closed) { this.closed = true; this.onclose?.(); } }
    push(snapshot) { this.onmessage?.({ data: JSON.stringify({ type: "snapshot", sequence: 1, snapshot }) }); }
  }
  FakeSocket.blocked = blocked;
  const context = vm.createContext({ URL, AbortController, console,
    window: { location: { href: "https://eez.asuscomm.com/monitor/" },
      addEventListener: (name, fn) => { events[name] = fn; } },
    document: { getElementById: element, createElement: () => element("created") },
    WebSocket: unavailable ? undefined : FakeSocket,
    fetch: (url, options) => new Promise((resolve, reject) => {
      requests.push({ url: String(url), resolve, reject });
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    setTimeout: (fn, ms) => { const id = ++timer; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++timer; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  vm.runInContext(app + "\nglobalThis.api = { state, refresh, connectLive };", context);
  return { ...context.api, element, elements, sockets, requests, timeouts, intervals, events, FakeSocket,
    runTimer(id) { const entry = timeouts.get(id); assert.ok(entry); timeouts.delete(id); entry.fn(); } };
}

function snapshot(height, hash = "aa") {
  return { generatedAt: "2026-09-14T12:00:00Z", healthy: true, errors: [], configuration: { refreshSeconds: 4 },
    chains: { l1: { healthy: true, latest: { number: 23053000 } },
      l2: { healthy: true, latest: { number: height, hash: "0x" + hash.repeat(32) } } } };
}
const response = (data) => ({ ok: true, json: async () => data });
const tick = () => new Promise(setImmediate);

const f = fixture();
assert.equal(f.sockets[0].url, "wss://eez.asuscomm.com/monitor/api/live");
assert.equal(f.requests.length, 0, "connected viewers must not poll snapshots");
f.sockets[0].push(snapshot(12));
assert.equal(f.state.snapshot.chains.l2.latest.number, 12);
assert.equal(f.intervals.size, 0);
assert.match(f.elements.get("live-status").innerHTML, /Live updates/);

const delayed = snapshot(12);
delayed.healthy = false;
delayed.chains.l1.freshness = { ageSeconds: 138, warningSeconds: 30, status: "delayed" };
delayed.chains.l2.freshness = { ageSeconds: 133, warningSeconds: 30, status: "delayed" };
f.sockets[0].push(delayed);
assert.match(f.elements.get("live-status").innerHTML, /Live updates/, "head delay must not disconnect a working feed");
assert.match(f.elements.get("network-status").innerHTML, /L1 \+ L2 head delayed/);
assert.match(f.elements.get("l1-freshness").textContent, /Head delayed/);
assert.match(f.elements.get("errors").innerHTML, /snapshot is updating/);
f.sockets[0].push({ ...delayed, stale: true });
assert.match(f.elements.get("network-status").innerHTML, /Stale/);
assert.match(f.elements.get("errors").innerHTML, /Cached snapshot/);
assert.doesNotMatch(f.elements.get("errors").innerHTML, /snapshot is updating/);
const recovered = snapshot(13);
recovered.chains.l1.freshness = { ageSeconds: 3, warningSeconds: 30, status: "current" };
recovered.chains.l2.freshness = { ageSeconds: 2, warningSeconds: 30, status: "current" };
f.sockets[0].push(recovered);
assert.match(f.elements.get("network-status").innerHTML, /Healthy/);
assert.doesNotMatch(f.elements.get("l1-freshness").textContent, /Head delayed/);
assert.doesNotMatch(f.elements.get("errors").innerHTML, /snapshot is updating/);

const pending = f.refresh();
assert.equal(f.requests.length, 1);
f.sockets[0].push(snapshot(13));
f.requests[0].resolve(response(snapshot(11)));
await pending;
assert.equal(f.state.snapshot.chains.l2.latest.number, 13, "late HTTP response overwrote live state");

f.state.blobQuery = "L2:12";
f.element("decoder-result").innerHTML = "Previously decoded transaction";
f.sockets[0].push(snapshot(11, "bb"));
assert.equal(f.state.snapshot.chains.l2.latest.number, 11, "reorg to a lower height must be accepted");
assert.equal(f.state.blobQuery, "L2:12");
assert.equal(f.elements.get("decoder-result").innerHTML, "Previously decoded transaction");

const old = f.sockets[0];
old.close();
assert.equal(f.intervals.size, 1);
assert.equal([...f.intervals.values()][0].ms, 4000);
assert.match(f.elements.get("live-status").innerHTML, /Polling/);
assert.equal(f.timeouts.get(f.state.reconnectTimer).ms, 1000);
f.runTimer(f.state.reconnectTimer);
assert.equal(f.sockets.length, 2);
f.sockets[1].push(snapshot(15, "cc"));
old.push(snapshot(999));
assert.equal(f.state.snapshot.chains.l2.latest.number, 15, "old connection callbacks must be ignored");
assert.equal(f.intervals.size, 0);
f.requests[1].resolve(response(snapshot(14)));
await tick();
assert.equal(f.state.snapshot.chains.l2.latest.number, 15);

f.runTimer(f.state.liveTimer);
assert.equal(f.sockets[1].closed, true, "stalled live feed must reconnect");
assert.equal(f.intervals.size, 1);
f.runTimer(f.state.reconnectTimer);
f.sockets[2].push(snapshot(16));
assert.equal(f.intervals.size, 0);
f.requests[2].resolve(response(snapshot(14)));
await tick();

f.sockets[2].onmessage({ data: "not-json" });
assert.equal(f.sockets[2].closed, true, "malformed payload must fall back safely");
f.events.pagehide();
assert.equal(f.state.stopped, true);
assert.equal(f.state.socket, null);
assert.equal(f.intervals.size, 0);
assert.equal(f.timeouts.has(f.state.reconnectTimer), false);
f.events.pageshow();
assert.equal(f.sockets.length, 4, "restored page must reconnect");
f.sockets[3].push(snapshot(17));
f.requests[3].resolve(response(snapshot(14)));
await tick();
assert.equal(f.state.snapshot.chains.l2.latest.number, 17);
f.events.pagehide();

const unsupported = fixture({ unavailable: true });
assert.equal(unsupported.requests.length, 1);
assert.equal(unsupported.intervals.size, 1);
unsupported.requests[0].resolve(response(snapshot(12)));
await tick();
assert.equal(unsupported.state.snapshot.chains.l2.latest.number, 12);
unsupported.events.pagehide();

const blocked = fixture({ blocked: true });
for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
  assert.equal(blocked.timeouts.get(blocked.state.reconnectTimer).ms, delay);
  blocked.runTimer(blocked.state.reconnectTimer);
}
assert.equal(blocked.requests.length, 1, "fallback HTTP requests must not overlap");
blocked.FakeSocket.blocked = false;
blocked.runTimer(blocked.state.reconnectTimer);
blocked.sockets[0].push(snapshot(12));
assert.equal(blocked.intervals.size, 0);
blocked.requests[0].reject(new Error("old HTTP failure"));
await tick();
assert.match(blocked.elements.get("network-status").innerHTML, /Healthy/);
blocked.events.pagehide();
console.log("live monitor tests passed: WSS URL, push delivery, HTTP race, reorg, persistent inputs, reconnect, watchdog, malformed data, page lifecycle, fallback, bounded retries");
