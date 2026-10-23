import { randomUUID } from "node:crypto";

// Each viewer owns a lease. Cancelling one lease never cancels another viewer's
// shared decode. Entries are scoped to this service's fixed deployment config.
export class JobStore {
  constructor(run, { concurrency = 2, maxJobs = 16, maxClients = 64, leaseMs = 45000,
    cacheMs = 30000, partialCacheMs = 5000, maxResultBytes = 8 * 1024 * 1024,
    maxCacheBytes = 32 * 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { run, concurrency, maxJobs, maxClients, leaseMs, cacheMs,
      partialCacheMs, maxResultBytes, maxCacheBytes, now });
    this.entries = new Set(); this.byKey = new Map(); this.clients = new Map();
    this.running = 0; this.closed = false;
  }
  remove(entry) {
    this.entries.delete(entry);
    if (this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
  }
  sweep() {
    for (const [id, client] of this.clients) if (this.now() - client.touched > this.leaseMs) this.release(id);
    for (const entry of this.entries) {
      if (!entry.clients.size && entry.expires <= this.now() && !["queued", "running"].includes(entry.state)) this.remove(entry);
    }
  }
  create(request) {
    this.sweep();
    if (this.closed || this.clients.size >= this.maxClients) throw Object.assign(new Error("Decoder is busy. Try again shortly."), { status: 429 });
    const key = [request.hash.toLowerCase(), request.chain, request.chainIds.l1, request.chainIds.l2].join(":");
    let entry = this.byKey.get(key);
    if (entry && !["queued", "running"].includes(entry.state) &&
      (request.refresh || entry.state === "failed" || entry.expires <= this.now())) entry = null;
    if (!entry) {
      // Evict unused cached entries before rejecting new work.
      if (this.entries.size >= this.maxJobs) for (const cached of this.entries) {
        if (!cached.clients.size && !["queued", "running"].includes(cached.state)) this.remove(cached);
        if (this.entries.size < this.maxJobs) break;
      }
      if (this.entries.size >= this.maxJobs) throw Object.assign(new Error("Decoder queue is full. Try again shortly."), { status: 429 });
      entry = { key, request, state: "queued", progress: "Waiting for a decoder", error: null,
        errorCode: null, clients: new Set(), handle: null, json: null, bytes: 0, expires: Infinity };
      this.entries.add(entry); this.byKey.set(key, entry);
    }
    const id = randomUUID();
    entry.clients.add(id); this.clients.set(id, { entry, touched: this.now() });
    this.pump();
    return this.status(id);
  }
  client(id) {
    this.sweep();
    const client = this.clients.get(id);
    if (!client) throw Object.assign(new Error("Trace request expired. Please retry."), { status: 404 });
    client.touched = this.now();
    return client.entry;
  }
  status(id) {
    const entry = this.client(id);
    return { apiVersion: 1, id, state: entry.state, progress: entry.progress, error: entry.error, errorCode: entry.errorCode };
  }
  result(id) {
    const entry = this.client(id);
    if (entry.state !== "complete") throw Object.assign(new Error("The trace is not ready."), { status: 409 });
    return entry.json;
  }
  release(id) {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    const entry = client.entry;
    entry.clients.delete(id);
    if (!entry.clients.size && ["queued", "running"].includes(entry.state)) {
      entry.state = "cancelled";
      entry.handle?.cancel();
      this.remove(entry);
    }
  }
  pump() {
    if (this.closed) return;
    for (const entry of this.entries) {
      if (this.running >= this.concurrency) break;
      if (entry.state !== "queued" || !entry.clients.size) continue;
      this.running++; entry.state = "running"; entry.progress = "Reading transaction and network information";
      // Promise boundary handles a runner that throws before returning a handle.
      Promise.resolve().then(() => {
        if (entry.state !== "running") return null;
        entry.handle = this.run(entry.request, message => {
          if (entry.state === "running") entry.progress = String(message).slice(0, 200);
        });
        return entry.handle.promise;
      }).then(result => {
        if (entry.state !== "running" || !result) return;
        const bytes = Buffer.byteLength(result.json);
        if (bytes > this.maxResultBytes) throw Object.assign(new Error("Result too large"), { code: "result-limit" });
        let used = [...this.entries].reduce((sum, item) => sum + item.bytes, 0);
        for (const cached of this.entries) {
          if (used + bytes <= this.maxCacheBytes) break;
          if (cached !== entry && !cached.clients.size && cached.state === "complete") {
            used -= cached.bytes; this.remove(cached);
          }
        }
        if (used + bytes > this.maxCacheBytes) throw Object.assign(new Error("Cache full"), { code: "capacity" });
        entry.json = result.json; entry.bytes = bytes; entry.state = "complete";
        entry.progress = result.partial ? "Available trace data decoded; some evidence is missing" : "Trace decoded";
        entry.expires = this.now() + (result.partial ? this.partialCacheMs : this.cacheMs);
      }).catch(error => {
        if (entry.state !== "running") return;
        entry.state = "failed"; entry.errorCode = error.code || "decode-failed";
        entry.error = publicError(entry.errorCode); entry.expires = this.now() + this.partialCacheMs;
      }).finally(() => { this.running--; this.pump(); });
    }
  }
  close() {
    this.closed = true;
    for (const id of this.clients.keys()) this.release(id);
    this.entries.clear(); this.byKey.clear();
  }
}

export function publicError(code) {
  return ({
    timeout: "Decoding exceeded the time limit. Retry or inspect a smaller transaction.",
    pending: "The transaction is still pending. Retry after it is included in a block.",
    "not-found": "Transaction not found on the selected network.",
    "network-mismatch": "The decoder and dashboard are configured for different networks.",
    "rpc-limit": "This trace exceeded the request limit.",
    "response-limit": "An upstream response exceeded the size limit.",
    "result-limit": "This trace is too large to display.",
    capacity: "The decoder is busy. Try again shortly.",
    cancelled: "Trace request cancelled.",
  })[code] || "The trace could not be decoded. Check the configured RPC and trace endpoints, then retry.";
}
