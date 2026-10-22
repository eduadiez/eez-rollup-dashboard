import { decodeEventLog, encodeEventTopics } from "viem";
import type { Address, Hex } from "viem";
import type { Intent, Outcome, TreasuryClient } from "./client.ts";
import { transferAbi } from "./transfers.ts";
import { decodeSafeExecution, safeExecutionTopics } from "./safeEvents.ts";
import { settledPayment } from "./payments.ts";

type Log = { address: Address; data: Hex; topics: [Hex, ...Hex[]]; transactionHash: Hex; blockHash: Hex; blockNumber: Hex };
type Receipt = { status: Hex; blockNumber: Hex; blockHash: Hex; logs: Log[] };
type Block = { number: Hex; hash: Hex };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function protocol(log: Log, address: Address, name: string) {
  if (!same(log.address, address)) return;
  try { const e = decodeEventLog({ abi: transferAbi, ...log }); if (e.eventName === name) return e.args as Record<string, unknown>; } catch { /* Unrelated event. */ }
}

/** Correlate the exact relayed Safe calldata and sender, then require Safe success
 * and payment effects inside the L2 block settled by this Ethereum source block.
 * A Safe signature hash alone cannot associate a relay attempt with settlement.
 */
export async function mirrorRelayOutcome(client: TreasuryClient, intent: Intent): Promise<Outcome> {
  const c = client.config, p = c.payments!;
  check(p.bridgeKind === "standard" && p.safeL2Alias && intent.l2StartBlock && intent.payment && intent.payment.source !== "l1", "Missing mirror relay identity");
  let hash = intent.hash;
  if (!hash) {
    const logs = await client.rpc<Log[]>(c.l1.rpc, "eth_getLogs", [{ address: c.registry, fromBlock: intent.startBlock, toBlock: "latest",
      topics: encodeEventTopics({ abi: transferAbi, eventName: "CrossChainCallExecuted", args: { proxy: p.safeL2Alias } }) }]);
    const matches = logs.filter(log => {
      const e = protocol(log, c.registry, "CrossChainCallExecuted");
      return e && same(e.sourceAddress as string, intent.sender) && same(e.callData as string, intent.data) && e.value === 0n;
    });
    // Replacements share calldata; the EOA nonce distinguishes this submission.
    const identities = new Set<Hex>();
    for (const log of matches) {
      const tx = await client.rpc<{ nonce: Hex } | null>(c.l1.rpc, "eth_getTransactionByHash", [log.transactionHash]);
      if (tx && BigInt(tx.nonce) === BigInt(intent.sourceNonce)) identities.add(log.transactionHash);
    }
    check(identities.size <= 1, "Ambiguous mirror submission; keep this request for verification");
    hash = [...identities][0];
  }
  if (!hash) return { kind: "unknown", detail: "Waiting for the Ethereum submission. This payment will not be resubmitted automatically." };
  const pending = (): Outcome => ({ kind: "pending", hash, detail: "Verifying the Ethereum submission and EEZ-X Safe execution." });
  const [receipt, status] = await Promise.all([
    client.rpc<Receipt | null>(c.l1.rpc, "eth_getTransactionReceipt", [hash]),
    client.rpc<{ lifecycle?: string; ownership?: { reason?: string } } | null>(c.l1.front!, "eez_getCrossChainTransaction", [hash]),
  ]);
  if (!receipt) {
    const reason = status?.ownership?.reason;
    if (status?.lifecycle === "terminal" && ["PoolDiscarded", "AttemptsExhausted", "NonceGap"].includes(reason ?? ""))
      return { kind: "rejected", hash, rejectionStage: "preparation", detail: `Composer ended this request (${reason}). Review again before retrying.` };
    return pending();
  }
  const [tx, block] = await Promise.all([
    client.rpc<{ from: Address; to: Address; input: Hex; nonce: Hex; value: Hex } | null>(c.l1.rpc, "eth_getTransactionByHash", [hash]),
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
  ]);
  check(tx && same(tx.from, intent.sender) && same(tx.to, p.safeL2Alias) && same(tx.input, intent.data)
    && BigInt(tx.nonce) === BigInt(intent.sourceNonce) && BigInt(tx.value) === 0n, "Ethereum transaction does not match the reviewed mirror payment");
  if (block?.hash !== receipt.blockHash) return pending();
  if (receipt.status !== "0x1") return { kind: "rejected", hash, sourceBlock: String(BigInt(receipt.blockNumber)), rejectionStage: "execution", detail: "The Ethereum relay transaction reverted." };
  const calls = receipt.logs.flatMap(log => {
    const e = protocol(log, c.registry, "CrossChainCallExecuted");
    return e && same(e.proxy as string, p.safeL2Alias!) && same(e.sourceAddress as string, intent.sender)
      && same(e.callData as string, intent.data) && e.value === 0n ? [e] : [];
  });
  check(calls.length === 1, "Missing unique mirror relay execution");
  const callHash = calls[0]!.crossChainCallHash as Hex;
  const origins = await client.rpc<Log[]>(c.l1.rpc, "eth_getLogs", [{ address: c.registry, blockHash: receipt.blockHash,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "CrossChainCallExecuted", args: { crossChainCallHash: callHash } }) }]);
  check(origins.length === 1 && same(origins[0]!.transactionHash, hash), "Ambiguous relay source identity");
  const safe = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]);
  if (!safe || BigInt(safe.number) < BigInt(intent.l2StartBlock)) return pending();
  const logs = await client.rpc<Log[]>(c.l2.rpc, "eth_getLogs", [{ address: c.safeL2, fromBlock: intent.l2StartBlock, toBlock: safe.number, topics: [safeExecutionTopics] }]);
  const candidates = logs.filter(log => same(log.address, c.safeL2) && decodeSafeExecution(log)?.args.txHash === intent.safeHash);
  const matches: { log: Log; receipt: Receipt }[] = [];
  for (const log of candidates) {
    const destination = await client.rpc<Receipt | null>(c.l2.rpc, "eth_getTransactionReceipt", [log.transactionHash]);
    if (!destination || destination.blockHash !== log.blockHash || !destination.logs.some(item => {
      const e = protocol(item, c.manager, "IncomingCrossChainCallExecuted");
      return e && e.crossChainCallHash === callHash && e.isStatic === false && e.sourceRollup === 0n && e.value === 0n
        && same(e.sourceAddress as string, intent.sender) && same(e.destination as string, c.safeL2) && same(e.data as string, intent.data);
    })) continue;
    const settlement = await client.rpc<{ canonicalL2: boolean; l1BlockHash: Hex; l1BlockNumber: Hex; l2Blocks: Block[] } | null>(c.l2.front, "eez_getSettlementByL2Block", [log.blockHash]);
    if (settlement?.canonicalL2 && same(settlement.l1BlockHash, receipt.blockHash) && BigInt(settlement.l1BlockNumber) === BigInt(receipt.blockNumber)
      && settlement.l2Blocks.some(b => same(b.hash, log.blockHash) && BigInt(b.number) === BigInt(log.blockNumber))) matches.push({ log, receipt: destination });
  }
  if (!matches.length) return pending();
  check(matches.length === 1, "Ambiguous mirror execution evidence");
  const match = matches[0]!;
  const contributions = settledPayment(c, intent.payment, match.receipt.logs);
  check(match.receipt.status === "0x1" && decodeSafeExecution(match.log)?.eventName === "ExecutionSuccess" && contributions, "Mirror Safe did not complete the reviewed payment");
  const [l1Again, l2Again, safeAgain] = await Promise.all([
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [match.log.blockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]),
  ]);
  if (l1Again?.hash !== receipt.blockHash || l2Again?.hash !== match.log.blockHash || !safeAgain || BigInt(safeAgain.number) < BigInt(match.log.blockNumber)) return pending();
  return { kind: "settled", hash, execution: { l1: hash, l2: match.log.transactionHash }, sourceBlock: String(BigInt(receipt.blockNumber)),
    block: String(BigInt(match.log.blockNumber)), contributions, detail: "Payment completed. The EEZ-X Safe execution and Ethereum submission are verified." };
}
