import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ENV_FILE, loadConfig, loadEnvironmentConfig, parseEnv } from "../src/config.mjs";
import { explorersFromEnv } from "../flow/render-flow.mjs";

const hash = "0x" + "12".repeat(32);
const rpcEnv = { EEZ_UI_L1_RPC_UPSTREAM: "https://l1.test", EEZ_UI_L2_RPC_UPSTREAM: "https://l2.test" };
const example = fs.readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

// No private deployment files, RPC calls, installed dependencies, or disk writes.
function files(t, contents = {}) {
  t.mock.method(fs, "existsSync", file => Object.hasOwn(contents, String(file)));
  t.mock.method(fs, "readFileSync", file => {
    assert.ok(Object.hasOwn(contents, String(file)), "Unexpected file read: " + file);
    return contents[String(file)];
  });
}

test("repository settings map to the engine's configuration", t => {
  files(t);
  const env = {
    ...rpcEnv,
    EEZ_UI_L1_FRONT_UPSTREAM: "https://composer-l1.test",
    EEZ_UI_L2_FRONT_UPSTREAM: "https://composer-l2.test",
    EEZ_UI_L1_TRACE_RPC_UPSTREAM: "https://archive-l1.test",
    EEZ_UI_L2_TRACE_RPC_UPSTREAM: "https://archive-l2.test",
    EEZ_REGISTRY_ADDRESS: "registry", EEZL2_ADDRESS: "l2-manager",
    EEZ_ROLLUP_MANAGER_ADDRESS: "rollup-manager",
    EEZ_TRACE_L1_EXPLORER_API_KEY: "key1", EEZ_TRACE_L2_EXPLORER_API_KEY: "key2",
    EEZ_TRACE_ETHERSCAN_API_KEY: "shared", PRIVATE_KEY: "never-read",
    EEZ_UI_NETWORK_NAME: "display-only",
  };
  const config = loadConfig([hash], env);
  for (const [option, key] of Object.entries({
    l1Rpc: "EEZ_UI_L1_RPC_UPSTREAM", l2Rpc: "EEZ_UI_L2_RPC_UPSTREAM",
    l1Front: "EEZ_UI_L1_FRONT_UPSTREAM", l2Front: "EEZ_UI_L2_FRONT_UPSTREAM",
    l1TraceRpc: "EEZ_UI_L1_TRACE_RPC_UPSTREAM", l2TraceRpc: "EEZ_UI_L2_TRACE_RPC_UPSTREAM",
  })) assert.equal(config[option], env[key]);
  assert.equal(config.rollups, "registry");
  assert.equal(config.managerL2, "l2-manager");
  assert.equal(config.rollupManager, undefined);
  assert.equal(config.l1ExplorerApiKey, "key1");
  assert.equal(config.l2ExplorerApiKey, "key2");
  assert.equal(config.etherscanApiKey, "shared");
  assert.deepEqual(config.explicitManagers, { L1: true, L2: true });
  assert.ok(!JSON.stringify(config).includes("never-read"));
  assert.ok(!JSON.stringify(config).includes("display-only"));
});

test("default .env is the repository root even when invoked from another directory", t => {
  files(t, { [DEFAULT_ENV_FILE]: "EEZ_UI_L1_RPC_UPSTREAM=https://file-l1.test\nEEZ_UI_L2_RPC_UPSTREAM=https://file-l2.test" });
  for (const cwd of [path.dirname(DEFAULT_ENV_FILE), "/unrelated", path.join(path.dirname(DEFAULT_ENV_FILE), "trace-decoder")]) {
    const config = loadConfig([hash], {}, cwd);
    assert.equal(config.envFile, DEFAULT_ENV_FILE);
    assert.equal(config.l1Rpc, "https://file-l1.test");
    assert.equal(config.l2Rpc, "https://file-l2.test");
  }
});

test("an explicit file replaces the default and resolves against the working directory", t => {
  files(t, {
    [DEFAULT_ENV_FILE]: "EEZ_UI_L1_RPC_UPSTREAM=https://wrong-chain.test\nEEZ_REGISTRY_ADDRESS=wrong",
    "/project/network.env": "L1_RPC=https://chosen-l1.test\nL2_RPC=https://chosen-l2.test",
    "/project/other.env": "L1_RPC=https://other.test",
  });
  const config = loadConfig([hash, "--env-file", "network.env"], { DEVNET_ENV: "other.env" }, "/project");
  assert.equal(config.envFile, "/project/network.env");
  assert.equal(config.l1Rpc, "https://chosen-l1.test");
  assert.equal(config.l2Rpc, "https://chosen-l2.test");
  assert.equal(config.rollups, undefined);
});

test("DEVNET_ENV remains supported and missing explicit files fail", t => {
  files(t, { "/project/legacy.env": "L1_RPC=one\nL2_RPC=two" });
  assert.equal(loadConfig([hash], { DEVNET_ENV: "legacy.env" }, "/project").l1Rpc, "one");
  assert.throws(() => loadConfig([hash, "--env-file", "missing.env"], rpcEnv, "/project"), /Environment file not found/);
  assert.throws(() => loadEnvironmentConfig({ env: { DEVNET_ENV: "/missing.env" } }), /Environment file not found/);
});

test("source precedence works across legacy aliases and repository names", t => {
  files(t, { [DEFAULT_ENV_FILE]: "EEZ_UI_L1_RPC_UPSTREAM=file-canonical\nL1_RPC=file-legacy\nL2_RPC=file-l2" });
  assert.equal(loadConfig([hash], {}).l1Rpc, "file-canonical");
  assert.equal(loadConfig([hash], { L1_RPC: "exported-legacy" }).l1Rpc, "exported-legacy");
  const env = { L1_RPC: "exported-legacy", EEZ_UI_L1_RPC_UPSTREAM: "exported-canonical" };
  assert.equal(loadConfig([hash], env).l1Rpc, "exported-canonical");
  assert.equal(loadConfig([hash, "--l1-rpc", "cli"], env).l1Rpc, "cli");
});

test("empty optional settings preserve explorer fallback and read-RPC trace fallback", t => {
  files(t);
  const config = loadConfig([hash, "--l1-rpc", "https://override.test"], {
    ...rpcEnv, EEZ_UI_L1_TRACE_RPC_UPSTREAM: "", EEZ_UI_L2_TRACE_RPC_UPSTREAM: " ",
    EEZ_UI_L1_EXPLORER_API_URL: "", EEZ_UI_L1_EXPLORER_URL: "https://scan.test",
  });
  assert.equal(config.l1Rpc, "https://override.test");
  assert.equal(config.l1TraceRpc, undefined);
  assert.equal(config.l2TraceRpc, undefined);
  assert.equal(config.l1Explorer, "https://scan.test");
});

test("trace and historical manager CLI flags override deployment settings", t => {
  files(t);
  const config = loadConfig([hash, "--l1-trace-rpc", "archive-cli", "--l1-manager", "historical"], {
    ...rpcEnv, EEZ_UI_L1_TRACE_RPC_UPSTREAM: "archive-env", EEZ_REGISTRY_ADDRESS: "current",
  });
  assert.equal(config.l1TraceRpc, "archive-cli");
  assert.equal(config.rollups, "historical");
  assert.deepEqual(config.explicitManagers, { L1: true, L2: false });
});

test("public explorer links remain separate from API URLs for live and saved traces", t => {
  files(t, { [DEFAULT_ENV_FILE]: [
    "EEZ_UI_L1_EXPLORER_API_URL=https://api.scan.test/v2/api",
    "EEZ_UI_L1_EXPLORER_URL=https://scan.test",
    "EEZ_UI_L2_EXPLORER_API_URL=https://api.rollup.test/api/v2",
    "EEZ_UI_L2_EXPLORER_URL=https://rollup.test",
  ].join("\n") });
  const config = loadConfig([hash], rpcEnv);
  assert.equal(config.l1Explorer, "https://api.scan.test/v2/api");
  assert.equal(config.l1ExplorerUrl, "https://scan.test");
  assert.equal(config.l2Explorer, "https://api.rollup.test/api/v2");
  assert.equal(config.l2ExplorerUrl, "https://rollup.test");
  assert.deepEqual(explorersFromEnv([], {}), { L1: "https://scan.test", L2: "https://rollup.test" });
});

test("saved-JSON configuration honors explicit files, environment overrides, and errors", t => {
  files(t, { "/project/view.env": "EEZ_UI_L1_EXPLORER_URL=https://file.test" });
  assert.deepEqual(explorersFromEnv(["--env-file", "view.env"], { EXPLORER_L1: "https://env.test" }, "/project"),
    { L1: "https://env.test", L2: undefined });
  assert.throws(() => explorersFromEnv(["--env-file"], {}), /needs a value/);
  assert.throws(() => explorersFromEnv(["--env-file", "/missing.env"], {}), /Environment file not found/);
});

test("the shared environment loader does not require a transaction", t => {
  files(t);
  assert.equal(loadEnvironmentConfig({ env: rpcEnv }).l2Rpc, "https://l2.test");
  assert.throws(() => loadConfig([], rpcEnv), /transaction hash/);
});

test("only allowlisted configuration is parsed and shell expressions are never evaluated", () => {
  assert.deepEqual(parseEnv("PRIVATE_KEY=secret\nUNRELATED=$(touch /tmp/no)\nEEZ_UI_L1_RPC_UPSTREAM='https://l1.test' # read\n"), {
    EEZ_UI_L1_RPC_UPSTREAM: "https://l1.test",
  });
  assert.throws(() => parseEnv("EEZ_UI_L1_RPC_UPSTREAM=$(cat /secrets)"), /Shell/);
  assert.throws(() => parseEnv("EEZ_UI_L1_RPC_UPSTREAM=${PRIVATE_KEY}"), /Unsupported/);
  assert.throws(() => parseEnv("EEZ_UI_L1_RPC_UPSTREAM=${L1_RPC}\nL1_RPC=${EEZ_UI_L1_RPC_UPSTREAM}"), /Cyclic/);
});

test("exported values win when expanding allowlisted file references", () => {
  const parsed = parseEnv("EEZ_UI_L1_RPC_UPSTREAM=file\nEEZ_UI_L1_TRACE_RPC_UPSTREAM=${EEZ_UI_L1_RPC_UPSTREAM}", {
    EEZ_UI_L1_RPC_UPSTREAM: "exported",
  });
  assert.equal(parsed.EEZ_UI_L1_TRACE_RPC_UPSTREAM, "exported");
  assert.deepEqual(parseEnv("export L1_RPC=https://legacy.test\nL2_RPC=${L1_RPC}"), {
    L1_RPC: "https://legacy.test", L2_RPC: "https://legacy.test",
  });
});

test("existing CLI validation still rejects incomplete ranges and unknown settings", t => {
  files(t);
  assert.throws(() => loadConfig([hash, "--l1-from", "5"], rpcEnv), /both/);
  assert.throws(() => loadConfig([hash, "--l1-from", "5", "--l1-to", "4"], rpcEnv), /Inverted/);
  assert.throws(() => loadConfig([hash, "--l1-explorer-type", "invalid"], rpcEnv), /Invalid/);
  assert.throws(() => loadConfig([hash, "--unknown"], rpcEnv), /Unknown/);
  assert.equal(loadConfig(["--help"], {}).help, true);
});

test("the root example supplies configuration without publishing trace credentials to browsers", () => {
  const parsed = parseEnv(example);
  assert.equal(parsed.EEZ_UI_L1_RPC_UPSTREAM, "http://host.docker.internal:19545");
  assert.equal(parsed.EEZ_UI_L2_FRONT_UPSTREAM, "http://host.docker.internal:19548");
  assert.equal(parsed.EEZ_UI_L1_TRACE_RPC_UPSTREAM, "");
  assert.equal(parsed.EEZ_UI_L2_TRACE_RPC_UPSTREAM, "");
  assert.equal(parsed.EEZ_TRACE_ETHERSCAN_API_KEY, "");
  const browserTemplate = fs.readFileSync(new URL("../../config.template.json", import.meta.url), "utf8");
  assert.ok(!/TRACE_RPC|EXPLORER_API_KEY|ETHERSCAN_API_KEY/.test(browserTemplate));
});

test("transaction link mode is shared by the API and CLI, with CLI precedence", t => {
  files(t, { [DEFAULT_ENV_FILE]: "EEZ_TX_LINKS=required" });
  assert.equal(loadEnvironmentConfig({ env: {} }).txLinks, "required");
  assert.equal(loadEnvironmentConfig({ env: { EEZ_TX_LINKS: "off" } }).txLinks, "off");
  assert.equal(loadConfig([hash, "--tx-links", "auto"], { ...rpcEnv, EEZ_TX_LINKS: "off" }).txLinks, "auto");
  assert.throws(() => loadConfig([hash, "--tx-links", "invalid"], rpcEnv), /--tx-links must be/);
  assert.throws(() => loadConfig([hash], { ...rpcEnv, EEZ_TX_LINKS: "invalid" }), /--tx-links must be/);
});

test("file managers stay pinned for API and CLI when exported values are empty", t => {
  files(t, { [DEFAULT_ENV_FILE]: "ROLLUPS=historical-l1\nMANAGER_L2=historical-l2\nL1_TRACE_RPC=archive-file" });
  const env = { ...rpcEnv, ROLLUPS: "", MANAGER_L2: "", L1_TRACE_RPC: "" };
  for (const config of [loadEnvironmentConfig({ env }), loadConfig([hash], env)]) {
    assert.equal(config.rollups, "historical-l1");
    assert.equal(config.managerL2, "historical-l2");
    assert.equal(config.l1TraceRpc, "archive-file");
    assert.deepEqual(config.explicitManagers, { L1: true, L2: true });
  }
});
