import { keccak256, toHex } from "viem";
import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteCrossChainFees, sendCrossChainWithFees } from "./payment.mjs";

const cases = [
  ["0x1", "0x2"], ["0x27d8", "0x0"], ["0xaa29e", "0x0"], ["0x1892", "0x0"],
].flatMap(([chainId, rabbyType]) => [
  { chainId, isRabby: true, type: rabbyType },
  { chainId, isRabby: false, type: "0x2" },
]);
cases.push(
  { chainId: "0x1", isRabby: true, type: "0x0", explicitType: true },
  { chainId: "0xaa29e", isRabby: true, type: "0x2", explicitType: true },
  { chainId: "0x1", isRabby: false, type: "0x0", explicitType: true },
);

for (const { chainId, isRabby, type, explicitType } of cases) for (const automatic of [false, true]) test(`dashboard chain ${chainId} ${isRabby ? "Rabby" : "MetaMask"} ${explicitType ? "explicit" : "default"} type ${type} ${automatic ? "automatic" : "explicit"} gas preserves exact quoted fees through one wallet request`, async () => {
  const legacy = type === "0x0";
  const from = `0x${"11".repeat(20)}`;
  const tx = { to: `0x${"22".repeat(20)}`, ...(automatic ? {} : {gasLimit:"0x186a0"}), ...(explicitType ? {type} : {}), value: "0x5", data: "0x1234" };
  let sent = 0;
  let walletReads = 0;
  let shown;
  let quoted;
  let quoteFailure = false;
  const rpc = async (method, params) => {
    assert.notEqual(method, "eth_estimateGas", "quote estimates gas internally");
    if (method !== "eez_quoteFee") return ({ eth_getTransactionCount: "0x3", eth_chainId: chainId, eth_accounts: [from], eth_getBlockByNumber: { baseFeePerGas: "0xa" } })[method];
    if (quoteFailure) throw new Error("quote_unavailable");
    const [request, options] = params;
    assert.deepEqual(options.transactionTypes, [legacy ? "0x0" : "0x2"]);
    if (automatic) assert.equal(request.gas, undefined);
    if (request.nonce && request.nonce !== "0x3") throw new Error("nonce mismatch");
    const transaction = { ...request, nonce:"0x3", gas:request.gas ?? "0x186a0" };
    assert.deepEqual(transaction, { type: legacy ? "0x0" : "0x2", chainId, from, to: tx.to, nonce: "0x3", gas: "0x186a0", value: tx.value, data: tx.data });
    quoted = { ...transaction, ...(legacy ? { gasPrice: "0xf" } : { maxPriorityFeePerGas: "0x5", maxFeePerGas: "0xf" }) };
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(transaction).sort().map(k => [k, transaction[k]])));
    const quote = { version:1, chainId,nonce:"0x3",expiresAt:`0x${(Math.floor(Date.now()/1000)+30).toString(16)}`,
      options:[{ type:transaction.type,gas:transaction.gas,requestHash:keccak256(toHex(canonical)), estimatedFee:"0x4ce78",
        ...(legacy ? {gasPrice:"0xf"} : {maxPriorityFeePerGas:"0x5",maxFeePerGas:"0xf"}) }] };
    return quote;
  };
  const wallet = { isRabby, request: async ({ method, params }) => {
    walletReads++;
    assert.notEqual(method, "eez_quoteFee", "custom quotes use the Composer directly");
    if (method !== "eth_sendTransaction") return rpc(method);
    sent++;
    assert.deepEqual(params, [quoted]);
    assert.deepEqual(shown.transaction, quoted, "display callback must receive the exact fees sent to the wallet");
    return "0xhash";
  } };
  const args = { tx, from, chainId, rpc, wallet, maxTotalFee: 1_500_000n };
  const preview = await quoteCrossChainFees(args);
  assert.deepEqual(preview.transaction, quoted);
  assert.equal(walletReads, 0, "fee previews must not prompt or switch the wallet");
  assert.equal(sent, 0);
  assert.equal(await sendCrossChainWithFees({ ...args, onQuote: value => { shown = value; } }), "0xhash");
  assert.equal(sent, 1);
  await assert.rejects(sendCrossChainWithFees({ ...args, maxTotalFee: 1n }), /app limit/);
  for (const changed of [{ authorizationList: [] }, { from: tx.to }, { nonce: "0x4" }, ...(automatic ? [] : [{ gas: "0x9999" }]), { maxFeePerGas: "0x1" }]) {
    await assert.rejects(sendCrossChainWithFees({ ...args, tx: { ...tx, ...changed } }));
  }
  quoteFailure = true;
  await assert.rejects(sendCrossChainWithFees(args), /quote_unavailable/);
  assert.equal(sent, 1, "quote and transaction failures cannot fall back to wallet pricing");
});
