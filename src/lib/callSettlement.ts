import { config } from "../config";
import { rpcCall } from "../rpc";
import { fetchHistoryTransactions } from "./historyTransactions";
import type { DebugChain, DebugReceipt, Rpc, Settlement } from "./executionDebugger";

export type CallSettlement = {
  state: "pending" | "awaiting" | "posted" | "safe" | "finalized" | "reorg" | "unavailable";
  execution: "pending" | "confirmed" | "reverted" | "unverified";
  message: string;
  settlement?: Settlement;
  counterpartHashes: string[];
  localL1?: boolean;
};
type Block = { number: string; hash: string };
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const defaultRpc: Rpc = (url, method, params = []) => rpcCall(url, method, params, AbortSignal.timeout(10000));

/** Finality is backed by canonical hashes and node safe/finalized tags, never by elapsed time. */
export async function fetchCallSettlement(hash: string, chain: DebugChain, crossChain = true, rpc: Rpc = defaultRpc): Promise<CallSettlement> {
  const sourceRpc = chain === "l1" ? config.l1Rpc : config.l2Rpc;
  const receipt = await rpc(sourceRpc, "eth_getTransactionReceipt", [hash]) as DebugReceipt | null;
  const base: CallSettlement = { state: "pending", execution: "pending", message: "Waiting for source-chain inclusion.", counterpartHashes: [] };
  if (!receipt) return base;
  base.execution = receipt.status === "0x1" ? "confirmed" : "reverted";
  const source = await rpc(sourceRpc, "eth_getBlockByNumber", [receipt.blockNumber, false]) as Block | null;
  if (!source) return { ...base, state: "unavailable", execution: "unverified", message: "Source block is unavailable. Canonical inclusion is unverified." };
  if (!same(source.hash, receipt.blockHash)) return { ...base, state: "reorg", execution: "unverified", message: "Source inclusion changed after a reorganization. Waiting for canonical evidence." };
  const localL1 = chain === "l1" && !crossChain;
  let settlement: Settlement | undefined;
  let l2Target: Block | undefined;
  if (!localL1) {
    if (chain === "l2") {
      const record = await rpc(config.l2ProxyRpc, "eez_getSettlementByL2Block", [receipt.blockHash]) as Settlement | null;
      if (record && !record.l2Blocks.some(block => same(block.hash, receipt.blockHash))) {
        return { ...base, state: "unavailable", message: "The settlement index does not reference this transaction's L2 block." };
      }
      settlement = record ?? undefined;
    } else {
      const records = await rpc(config.l2ProxyRpc, "eez_getSettledL2RangesByL1Block", [receipt.blockHash]) as Settlement[] | null;
      settlement = records?.find(record => same(record.l1TransactionHash, hash) && same(record.l1BlockHash, receipt.blockHash));
      if (!settlement) {
        // Repeated call hashes remain unresolved: the history resolver requires unique protocol events.
        const counterparts = await fetchHistoryTransactions(hash, chain, (url, method, params) => rpc(url, method, params));
        if (counterparts?.lookupError) throw new Error(counterparts.lookupError);
        base.counterpartHashes = counterparts?.l2Hashes ?? [];
        const records = await Promise.all(base.counterpartHashes.map(async counterpart => {
          const other = await rpc(config.l2Rpc, "eth_getTransactionReceipt", [counterpart]) as DebugReceipt | null;
          if (!other) return null;
          const record = await rpc(config.l2ProxyRpc, "eez_getSettlementByL2Block", [other.blockHash]) as Settlement | null;
          return record?.l2Blocks.some(block => same(block.hash, other.blockHash)) ? record : null;
        }));
        const unique = new Map(records.filter((record): record is Settlement => !!record).map(record => [record.l1TransactionHash.toLowerCase(), record]));
        if (unique.size > 1) return { ...base, state: "unavailable", message: "This call spans multiple settlement records. Inspect its counterpart transactions individually." };
        settlement = [...unique.values()][0];
      }
    }
    if (!settlement) return { ...base, state: "awaiting", message: "Execution may precede settlement. No indexed L1 settlement for this call yet." };
    if (settlement.canonicalL2 === false) return { ...base, settlement, state: "reorg", message: "The indexed L2 range is noncanonical. Waiting for a replacement settlement." };
    if (settlement.canonicalL2 !== true || !settlement.l2Blocks.length) return { ...base, state: "unavailable", message: "The settlement index has not verified a canonical L2 range." };
    const anchor = await rpc(config.l1Rpc, "eth_getBlockByNumber", [settlement.l1BlockNumber, false]) as Block | null;
    if (!anchor) return { ...base, state: "unavailable", message: "The L1 posting block is unavailable. Settlement is unverified." };
    if (!same(anchor.hash, settlement.l1BlockHash)) return { ...base, state: "reorg", message: "The L1 posting block changed. Waiting for the settlement index to reconcile." };
    l2Target = settlement.l2Blocks.reduce((a, b) => BigInt(a.number) > BigInt(b.number) ? a : b);
    const canonicalL2 = await rpc(config.l2Rpc, "eth_getBlockByNumber", [l2Target.number, false]) as Block | null;
    if (!canonicalL2) return { ...base, state: "unavailable", message: "The posted L2 block is unavailable. Finality is unverified." };
    if (!same(canonicalL2.hash, l2Target.hash)) return { ...base, state: "reorg", message: "The posted L2 range changed. Waiting for canonical settlement evidence." };
  }
  const result: CallSettlement = { ...base, settlement, localL1, state: "posted", message: localL1 ? "Included on L1. This local transaction does not require L2 settlement." : "Posted in a canonical L1 block. Waiting for safety and finality." };
  const reached = async (tag: "safe" | "finalized") => {
    const heads = await Promise.allSettled([
      rpc(config.l1Rpc, "eth_getBlockByNumber", [tag, false]),
      ...(l2Target ? [rpc(config.l2Rpc, "eth_getBlockByNumber", [tag, false])] : []),
    ]);
    return heads.every((head, index) => head.status === "fulfilled" && head.value &&
      BigInt((head.value as Block).number) >= BigInt(index === 0 ? settlement?.l1BlockNumber ?? receipt.blockNumber : l2Target!.number));
  };
  if (await reached("finalized")) return { ...result, state: "finalized", message: localL1 ? "The L1 transaction is finalized." : "The posting block and posted L2 range are finalized." };
  if (await reached("safe")) return { ...result, state: "safe", message: localL1 ? "The L1 transaction is safe; finality is pending." : "The posting block and posted L2 range are safe; finality is pending." };
  return result;
}
