import assert from "node:assert/strict";
import test from "node:test";
import { traceRows } from "../flow/rows.mjs";

function model() {
  return {
    transactions: [{ chain: "L1", hash: "source", requested: true, inFlow: true }, { chain: "L2", hash: "other", inFlow: false }],
    roots: [{ node: 0, chain: "L1", tx: "source" }, { node: 4, chain: "L2", tx: "other" }],
    nodes: [
      { id: 0, chain: "L1", tx: "source", contract: "Caller", children: [1] },
      { id: 1, chain: "L1", tx: "source", protocol: true, children: [2] },
      { id: 2, chain: "L2", tx: "delivery", contract: "Counter", children: [3] },
      { id: 3, chain: "L1", tx: null, kind: "ghost", contract: "Unobserved", children: [] },
      { id: 4, chain: "L2", tx: "other", contract: "Unrelated", children: [] },
    ],
  };
}
test("hidden protocol nodes promote children while preserving crossing direction", () => {
  const rows = traceRows(model());
  assert.deepEqual(rows.map(row => row.node.id), [0, 2, 3]);
  assert.equal(rows[1].parent, 0);
  assert.equal(rows[2].node.kind, "ghost");
});
test("transaction selection can find a delivery nested under another transaction's root", () => {
  assert.deepEqual(traceRows(model(), { transaction: "L2:delivery" }).map(row => row.node.id), [2]);
  assert.deepEqual(traceRows(model(), { transaction: "L2:other" }).map(row => row.node.id), [4]);
});
test("search explores collapsed descendants and protocol visibility is explicit", () => {
  assert.deepEqual(traceRows(model(), { collapsed: new Set([0]) }).map(row => row.node.id), [0]);
  assert.deepEqual(traceRows(model(), { search: "counter", collapsed: new Set([0]) }).map(row => row.node.id), [2]);
  assert.deepEqual(traceRows(model(), { protocol: true }).map(row => row.node.id), [0, 1, 2, 3, 4]);
});
test("iterative traversal handles deep traces and guards against duplicate or cyclic edges", () => {
  const data = model();
  data.roots = [{ node: 0, chain: "L1", tx: "source" }];
  data.nodes = Array.from({ length: 10000 }, (_, id) => ({
    id, chain: "L1", tx: "source", children: id < 9999 ? [id + 1] : [0],
  }));
  assert.equal(traceRows(data).length, 10000);
});
