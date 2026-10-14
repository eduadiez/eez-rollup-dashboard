import { requestL2FeeQuote, sendQuotedTransaction } from "./l2-fees.mjs";

/** One ordinary wallet transaction, with a quote bound to its exact intent.
 * The RPC and quote URL must refer to the same Composer. All signers use this
 * path so neither wallet defaults nor local fee estimation replace the quote.
 */
export async function sendL2WithFees({ tx, from, chainId, rpc, wallet, url, maxTotalFee, log }) {
  const allowed = ["to", "data", "value", "gas", "gasLimit", "from", "chainId", "type", "nonce"];
  if (Object.keys(tx).some(key => !allowed.includes(key))) throw new Error("Unsupported fee-quoted transaction field");
  if (tx.from && tx.from.toLowerCase() !== from.toLowerCase()) throw new Error("Transaction sender changed");
  if (tx.chainId && BigInt(tx.chainId) !== BigInt(chainId)) throw new Error("Transaction chain changed");
  if (tx.type && BigInt(tx.type) !== 2n) throw new Error("Settlement fee quotes require a type-2 transaction");
  if (tx.gas && tx.gasLimit && BigInt(tx.gas) !== BigInt(tx.gasLimit)) throw new Error("Conflicting gas limits");
  const hex = value => `0x${BigInt(value).toString(16)}`;
  const nonce = await rpc("eth_getTransactionCount", [from, "pending"]);
  if (tx.nonce && BigInt(tx.nonce) !== BigInt(nonce)) throw new Error("Transaction nonce changed");
  const gas = tx.gas ?? tx.gasLimit ?? await rpc("eth_estimateGas", [{ from, to: tx.to, data: tx.data ?? "0x", value: tx.value ?? "0x0" }]);
  const intent = { type: "0x2", chainId: hex(chainId), from, to: tx.to, nonce: hex(nonce), gas: hex(gas), value: hex(tx.value ?? "0x0"), data: tx.data ?? "0x" };
  const quote = await requestL2FeeQuote({ url, intent, maxTotalFee });
  log?.(`L2 settlement quote: ${quote.estimate.requiredL2Tip} wei priority payment; wallet fee cap ${BigInt(quote.transaction.gas) * BigInt(quote.transaction.maxFeePerGas)} wei`);
  return sendQuotedTransaction({ wallet, quote, intent, maxTotalFee });
}
