import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "fs/promises";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeConfigPath = path.resolve(rootDir, ".runtime/config.json");

type RuntimeFile = {
  browser?: Record<string, unknown>;
  proxy?: Record<string, string>;
};

function loadRuntimeFile(): RuntimeFile {
  if (!fs.existsSync(runtimeConfigPath)) return {};
  return JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")) as RuntimeFile;
}

function runtimeConfigPlugin(runtime: RuntimeFile): Plugin {
  return {
    name: "eez-runtime-config",
    configureServer(server) {
      const base = process.env.EEZ_UI_BASE_PATH || "/dashboard/";
      for (const configPath of new Set(["/config.json", `${base}config.json`])) {
        server.middlewares.use(configPath, (_req, res) => {
          const latest = loadRuntimeFile();
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(latest.browser ?? runtime.browser ?? {}, null, 2));
        });
      }
    },
  };
}

function rpcProxy(target: string | undefined): ProxyOptions | undefined {
  if (!target) return undefined;
  return { target, changeOrigin: true, rewrite: () => "/" };
}

/**
 * Serve /shared/* requests from the /shared directory on disk.
 * In Docker, /shared is a volume mount with rollup.env.
 */
function serveSharedPlugin(): Plugin {
  return {
    name: "serve-shared",
    configureServer(server) {
      server.middlewares.use("/shared", (req, res, next) => {
        const filePath = `/shared${req.url || ""}`;
        readFile(filePath, "utf-8")
          .then((content) => {
            res.setHeader("Content-Type", "text/plain");
            res.end(content);
          })
          .catch(() => next());
      });
    },
  };
}

export default defineConfig(() => {
  const runtime = loadRuntimeFile();
  const proxy = runtime.proxy ?? {};
  const proxies = Object.fromEntries(
    Object.entries({
      "/monitor/api": {
        target: process.env.EEZ_MONITOR_UPSTREAM || "http://127.0.0.1:18080",
        changeOrigin: false,
        ws: true,
        rewrite: (url: string) => url.replace(/^\/monitor(?=\/|$)/, "") || "/",
      },
      "/rpc/l1": rpcProxy(proxy.l1Rpc),
      "/rpc/l2": rpcProxy(proxy.l2Rpc),
      "/composer/l1": rpcProxy(proxy.l1Front),
      "/composer/l2": rpcProxy(proxy.l2Front),
    }).filter((entry): entry is [string, NonNullable<ReturnType<typeof rpcProxy>>] => Boolean(entry[1])),
  );

  return {
    base: process.env.EEZ_UI_BASE_PATH || "/dashboard/",
    plugins: [react(), serveSharedPlugin(), runtimeConfigPlugin(runtime)],
    server: {
      port: 8080,
      host: "0.0.0.0",
      allowedHosts: true as const,
      proxy: proxies as Record<string, ProxyOptions>,
    },
    build: { outDir: "dist" },
  };
});
