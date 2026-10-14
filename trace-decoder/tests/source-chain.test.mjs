import assert from "node:assert/strict";
import test from "node:test";
import { decodeCrossChainTrace } from "../src/engine.mjs";
import { scenario } from "./fixtures/scenarios.mjs";

test("source chain selection restricts hash discovery but retains cross-chain execution", async () => {
  const f = scenario({ direction: "L1" });
  const result = await decodeCrossChainTrace({ ...f.config, originChain: "L1" }, f.trigger);
  assert.equal(result.origin.chain, "L1");
  assert.ok(result.transactions.some(tx => tx.chain === "L2"));
  assert.equal(result.outgoing[0].status, "matched");
});
test("an explicit wrong source does not silently inspect the other chain", async () => {
  const f = scenario({ direction: "L1" });
  await assert.rejects(decodeCrossChainTrace({ ...f.config, originChain: "L2" }, f.trigger), /not found/);
  await assert.rejects(decodeCrossChainTrace({ ...f.config, originChain: "other" }, f.trigger), /Invalid source chain/);
});
