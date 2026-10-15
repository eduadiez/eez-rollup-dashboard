import { test } from "node:test";
import assert from "node:assert/strict";
import { sendL2WithFees } from "./payment.mjs";

for (const legacy of [false, true]) test(`dashboard ${legacy ? "Rabby legacy" : "EIP-1559"} quote preserves exact fees through one wallet request`, async () => {
  const from = `0x${"11".repeat(20)}`;
  const tx = { to: `0x${"22".repeat(20)}`, gasLimit: "0x186a0", value: "0x5", data: "0x1234" };
  let sent = 0;
  let quoted;
  let quoteFailure = false;
  const rpc = async (method, params) => {
    if (method !== "eez_quoteL2ToL1Fee") return ({ eth_getTransactionCount: "0x3", eth_chainId: "0x1", eth_accounts: [from], eth_getBlockByNumber: { baseFeePerGas: "0xa" } })[method];
    if (quoteFailure) throw new Error("quote_unavailable");
    const [intent] = params;
    assert.deepEqual(intent, { type: legacy ? "0x0" : "0x2", chainId: "0x1", from, to: tx.to, nonce: "0x3", gas: tx.gasLimit, value: tx.value, data: tx.data });
    quoted = { ...intent, ...(legacy ? { gasPrice: "0xf" } : { maxPriorityFeePerGas: "0x5", maxFeePerGas: "0xf" }) };
    const quote = { version: 1, mode: "advisory", intent, transaction: quoted,
      issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 10,
      context: { l2ChainId: 1, rollupId: 1 }, policy: { id: `0x${"ab".repeat(32)}`, assumptions: { l2_chain_id: 1, rollup_id: 1 } },
      estimate: { basis: "isolated_native_l2_replay_and_projected_l1_post", sourceGasUsed: 21000, l2BaseFeePerGas: "10", grossL2Tip: "105000", requiredL2Tip: "100001" } };
    return quote;
  };
  const wallet = { isRabby: legacy, request: async ({ method, params }) => {
    assert.notEqual(method, "eez_quoteL2ToL1Fee", "custom quotes use the Composer directly");
    if (method !== "eth_sendTransaction") return rpc(method);
    sent++;
    assert.deepEqual(params, [quoted]);
    return "0xhash";
  } };
  const args = { tx, from, chainId: "0x1", rpc, wallet, maxTotalFee: 1_500_000n };
    assert.equal(await sendL2WithFees(args), "0xhash");
    assert.equal(sent, 1);
    await assert.rejects(sendL2WithFees({ ...args, maxTotalFee: 1n }), /app limit/);
    for (const changed of [{ authorizationList: [] }, { from: tx.to }, { nonce: "0x4" }, { gas: "0x9999" }, { maxFeePerGas: "0x1" }]) {
      await assert.rejects(sendL2WithFees({ ...args, tx: { ...tx, ...changed } }));
    }
    quoteFailure = true;
    await assert.rejects(sendL2WithFees(args), /quote_unavailable/);
    assert.equal(sent, 1, "quote and intent failures cannot fall back to wallet pricing");
});
