import { keccak256, toHex } from "viem";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendL2WithFees } from "./payment.mjs";

for (const legacy of [false, true]) for (const automatic of [false, true]) test(`dashboard ${legacy ? "Rabby legacy" : "EIP-1559"} ${automatic ? "automatic" : "explicit"} gas quote preserves exact fees through one wallet request`, async () => {
  const from = `0x${"11".repeat(20)}`;
  const tx = { to: `0x${"22".repeat(20)}`, ...(automatic ? {} : {gasLimit:"0x186a0"}), value: "0x5", data: "0x1234" };
  let sent = 0;
  let quoted;
  let quoteFailure = false;
  const rpc = async (method, params) => {
    assert.notEqual(method, "eth_estimateGas", "quote estimates gas internally");
    if (method !== "eez_quoteFee") return ({ eth_getTransactionCount: "0x3", eth_chainId: "0x1", eth_accounts: [from], eth_getBlockByNumber: { baseFeePerGas: "0xa" } })[method];
    if (quoteFailure) throw new Error("quote_unavailable");
    const [request, options] = params;
    assert.deepEqual(options.transactionTypes, [legacy ? "0x0" : "0x2"]);
    if (automatic) assert.equal(request.gas, undefined);
    if (request.nonce && request.nonce !== "0x3") throw new Error("nonce mismatch");
    const transaction = { ...request, nonce:"0x3", gas:request.gas ?? "0x186a0" };
    assert.deepEqual(transaction, { type: legacy ? "0x0" : "0x2", chainId: "0x1", from, to: tx.to, nonce: "0x3", gas: "0x186a0", value: tx.value, data: tx.data });
    quoted = { ...transaction, ...(legacy ? { gasPrice: "0xf" } : { maxPriorityFeePerGas: "0x5", maxFeePerGas: "0xf" }) };
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(transaction).sort().map(k => [k, transaction[k]])));
    const quote = { version:1, chainId:"0x1",nonce:"0x3",expiresAt:`0x${(Math.floor(Date.now()/1000)+10).toString(16)}`,
      options:[{ type:transaction.type,gas:transaction.gas,requestHash:keccak256(toHex(canonical)), estimatedFee:"0x4ce78",
        ...(legacy ? {gasPrice:"0xf"} : {maxPriorityFeePerGas:"0x5",maxFeePerGas:"0xf"}) }] };
    return quote;
  };
  const wallet = { isRabby: legacy, request: async ({ method, params }) => {
    assert.notEqual(method, "eez_quoteFee", "custom quotes use the Composer directly");
    if (method !== "eth_sendTransaction") return rpc(method);
    sent++;
    assert.deepEqual(params, [quoted]);
    return "0xhash";
  } };
  const args = { tx, from, chainId: "0x1", rpc, wallet, maxTotalFee: 1_500_000n };
    assert.equal(await sendL2WithFees(args), "0xhash");
    assert.equal(sent, 1);
    await assert.rejects(sendL2WithFees({ ...args, maxTotalFee: 1n }), /app limit/);
    for (const changed of [{ authorizationList: [] }, { from: tx.to }, { nonce: "0x4" }, ...(automatic ? [] : [{ gas: "0x9999" }]), { maxFeePerGas: "0x1" }]) {
      await assert.rejects(sendL2WithFees({ ...args, tx: { ...tx, ...changed } }));
    }
    quoteFailure = true;
    await assert.rejects(sendL2WithFees(args), /quote_unavailable/);
    assert.equal(sent, 1, "quote and transaction failures cannot fall back to wallet pricing");
});
