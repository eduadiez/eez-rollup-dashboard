// Browser regression with mocked API/RPC data. Does not send transactions.
// Requires an already-running dashboard and Playwright; not run during implementation.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const hash = "0x" + "ab".repeat(32), address = "0x" + "11".repeat(20);
const jobId = "11111111-1111-4111-8111-111111111111";
const model = {
  version: 1, schemaVersion: "1.0.0", label: "Counter.increment()", txHash: hash,
  origin: { chain: "L2", transactionId: "L2:" + hash },
  chains: { L1: { name: "Chiado", chainId: "10200" }, L2: { name: "EEZ test", chainId: "200" } },
  transactions: [{ chain: "L2", hash, block: 42, status: "success", role: "trigger", label: "Trigger · starts on L2", requested: true, traced: true, inFlow: true, evidence: [] }],
  roots: [{ node: 0, chain: "L2", tx: hash, role: "trigger" }],
  nodes: [{ id: 0, kind: "call", chain: "L2", role: "application", protocol: false, callType: "CALL",
    contract: "Counter", address, from: address, fn: "increment()", signature: "increment()",
    args: [{ name: "amount", type: "uint256", value: "7" }], ret: { status: "ok", items: [{ name: "count", type: "uint256", value: "8" }] },
    value: "0", isStatic: false, failed: false, reverted: false, gasUsed: "21000", tx: hash, block: 42,
    path: "0", input: "0x12345678", output: "0x", children: [] }],
  settlements: [], unresolved: [], stats: { frames: 1, crossings: 0, matched: 0, events: 0 },
};
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let creates = 0;
    await page.route("**/config.json", route => route.fulfill({ json: { networkName: "EEZ test", l1RpcUrl: "/rpc/l1", l2RpcUrl: "/rpc/l2" } }));
    await page.route("**/rpc/*", route => {
      const request = route.request().postDataJSON();
      const result = request.method === "eth_chainId" ? route.request().url().endsWith("/l1") ? "0x27d8" : "0xc8" : "0x0";
      return route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result } });
    });
    await page.route("**/trace/api/**", route => {
      if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
      if (route.request().url().endsWith("/result")) return route.fulfill({ json: { apiVersion: 1, partial: false, observedAt: "2026-10-14T12:00:00Z", model } });
      if (route.request().method() === "POST") {
        creates++;
        assert.equal(route.request().postDataJSON().hash, hash);
        assert.equal(route.request().postDataJSON().chainIds.l1, "10200");
      }
      return route.fulfill({ json: { apiVersion: 1, id: jobId, state: "complete", progress: "Trace decoded", error: null, errorCode: null } });
    });
    const url = process.env.EEZ_UI_URL || "http://127.0.0.1:8080/dashboard/";
    await page.goto(url + "#/visualizer?mode=trace&chain=l2&tx=" + hash);
    await page.getByRole("heading", { name: "Counter.increment()" }).waitFor();
    assert.equal(await page.locator("iframe").count(), 0);
    await page.getByRole("button", { name: /Counter.*CALL/ }).click();
    await page.getByLabel("Selected call details").getByText("amount", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Sequence", exact: true }).click();
    await page.getByRole("columnheader", { name: "Return / status" }).waitFor();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("heading", { name: "Counter.increment()" }).waitFor();
    assert.ok(creates >= 2);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const inspector = page.getByRole("link", { name: "Blocks & settlement →" });
    assert.ok((await inspector.getAttribute("href")).includes("mode=inspect"));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
