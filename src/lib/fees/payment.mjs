import { keccak256, toHex } from "viem";
import { requestFeeQuote, feeQuoteTransaction, sendFeeQuotedTransaction } from "./l2-fees.mjs";

/** One ordinary wallet transaction, with a quote bound to its exact transaction.
 * The RPC must point to the Composer. All signers use this path to pass the
 * quoted fee fields without recomputing them locally. Wallets may still edit
 * fees before signing; Composer validates the signed transaction at admission.
 */
export async function sendCrossChainWithFees({ tx, from, chainId, rpc, wallet, maxTotalFee, log }) {
  const allowed = ["to", "data", "value", "gas", "gasLimit", "from", "chainId", "type", "nonce"];
  if (Object.keys(tx).some(key => !allowed.includes(key))) throw new Error("Unsupported fee-quoted transaction field");
  if (tx.from && tx.from.toLowerCase() !== from.toLowerCase()) throw new Error("Transaction sender changed");
  if (tx.chainId && BigInt(tx.chainId) !== BigInt(chainId)) throw new Error("Transaction chain changed");
  // Rabby's custom-network flow uses legacy fees; its built-in Ethereum
  // network supports separate EIP-1559 priority fees.
  const type = tx.type ?? (wallet.isRabby && BigInt(chainId) !== 1n ? "0x0" : "0x2");
  if (![0n, 2n].includes(BigInt(type))) throw new Error("Settlement fee quotes require legacy or type-2 transactions");
  if (tx.gas && tx.gasLimit && BigInt(tx.gas) !== BigInt(tx.gasLimit)) throw new Error("Conflicting gas limits");
  const hex = value => `0x${BigInt(value).toString(16)}`;
  const gas = tx.gas ?? tx.gasLimit;
  const transaction = { type: hex(type), chainId: hex(chainId), from, to: tx.to,
    value: hex(tx.value ?? "0x0"), data: tx.data ?? "0x",
    ...(gas == null ? {} : {gas: hex(gas)}), ...(tx.nonce == null ? {} : {nonce: hex(tx.nonce)}) };
  const quote = await requestFeeQuote({ rpc, transaction });
  const args = { quote, transaction, type: transaction.type, chainId: transaction.chainId, maxTotalFee,
    keccak256: text => keccak256(toHex(text)) };
  const quotedTransaction = feeQuoteTransaction(args);
  const price = quotedTransaction.gasPrice ?? quotedTransaction.maxFeePerGas;
  log?.(`Estimated source-chain fee: ${BigInt(quote.options[0].estimatedFee)} wei; wallet fee cap ${BigInt(quotedTransaction.gas) * BigInt(price)} wei`);
  return sendFeeQuotedTransaction({ wallet, ...args });
}
