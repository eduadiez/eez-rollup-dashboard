import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvironmentConfig } from "../src/config.mjs";
import { JobStore } from "./jobs.mjs";
import { workerRunner } from "./runner.mjs";

export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["hash", "chain", "chainIds", "refresh"].includes(key))) {
    throw Object.assign(new Error("Expected a transaction hash, chain, and chain IDs."), { status: 400 });
  }
  const { hash, chain = "auto", chainIds, refresh = false } = body;
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash) || !["auto", "l1", "l2"].includes(chain) ||
      typeof refresh !== "boolean" || !chainIds || typeof chainIds !== "object" ||
      Object.keys(chainIds).some(key => !["l1", "l2"].includes(key)) ||
      !["l1", "l2"].every(key => typeof chainIds[key] === "string" && /^[1-9][0-9]{0,19}$/.test(chainIds[key]))) {
    throw Object.assign(new Error("Invalid transaction hash, chain, or chain IDs."), { status: 400 });
  }
  return { hash: hash.toLowerCase(), chain, chainIds: { l1: chainIds.l1, l2: chainIds.l2 }, refresh };
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
export function createHandler(store, { configured = true } = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/health" && req.method === "GET") {
        return send(res, configured ? 200 : 503, { ready: configured });
      }
      if (!configured) return send(res, 503, { error: "Trace RPCs are not configured." });
      if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403, { error: "Cross-site requests are not accepted." });
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: "Origin does not match this dashboard." });
      if (url.pathname === "/api/jobs" && req.method === "POST") {
        if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Send application/json." });
        if (Number(req.headers["content-length"] || 0) > 2048) return send(res, 413, { error: "Request body is too large." });
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 2048) throw Object.assign(new Error("Request body is too large."), { status: 413 });
        }
        let body;
        try { body = JSON.parse(text); } catch { return send(res, 400, { error: "Invalid JSON." }); }
        return send(res, 202, store.create(validateRequest(body)));
      }
      const match = /^\/api\/jobs\/([0-9a-f-]{36})(\/result)?$/.exec(url.pathname);
      if (match) {
        if (req.method === "GET") return send(res, 200, match[2] ? store.result(match[1]) : store.status(match[1]));
        if (req.method === "DELETE" && !match[2]) { store.release(match[1]); res.writeHead(204); return res.end(); }
      }
      return send(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "Trace request failed." });
    }
  };
}

function integer(raw, name, fallback, min, max) {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid " + name);
  return value;
}
export function startServer(env = process.env) {
  const config = loadEnvironmentConfig({ env });
  const timeoutMs = integer(config.traceTimeoutMs, "EEZ_TRACE_TIMEOUT_MS", 120000, 1000, 300000);
  const concurrency = integer(config.traceConcurrency, "EEZ_TRACE_CONCURRENCY", 2, 1, 4);
  const store = new JobStore(workerRunner(config, { timeoutMs }), { concurrency });
  const server = http.createServer(createHandler(store, { configured: !!config.l1Rpc && !!config.l2Rpc }));
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  const cleanup = setInterval(() => store.sweep(), 5000);
  cleanup.unref();
  server.on("close", () => { clearInterval(cleanup); store.close(); });
  server.listen(integer(config.tracePort, "EEZ_TRACE_PORT", 18081, 1, 65535), config.traceHost || "127.0.0.1");
  const stop = () => { store.close(); server.close(); server.closeAllConnections(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) startServer();
