import { decodeEventLog, keccak256, stringToHex } from "viem";
import { config } from "../config";
import { rpcCall } from "../rpc";
import { eezL1Abi, eezL2Abi } from "../abi/eez";
import type { Settlement } from "./executionDebugger";

type Chain = "l1" | "l2";
type Log = { address: string; topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}`; blockHash: string; blockNumber: string; transactionHash: string };
export type HistoryTransactions = {
  chain: Chain; l1?: number; l2?: number;
  l1Hash?: string; l2Hashes: string[]; settlement?: boolean;
};
const outbound = keccak256(stringToHex("CrossChainCallExecuted(bytes32,address,address,bytes,uint256)"));
const inbound = keccak256(stringToHex("IncomingCrossChainCallExecuted(bytes32,bool,address,uint64,address,uint256,uint64,bytes)"));
const txHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);

/** Only resolve counterpart transactions from canonical settlement and unique protocol events.
 * A call hash can repeat; ambiguous matches stay unresolved rather than linking an arbitrary tx. */
export async function fetchHistoryTransactions(
  hash: string,
  preferred: Chain,
  rpc = (url: string, method: string, params: unknown[]) => rpcCall(url, method, params, AbortSignal.timeout(10000)),
): Promise<HistoryTransactions | null> {
  for (const chain of [preferred, preferred === "l1" ? "l2" : "l1"] as const) {
    let receipt: { blockNumber: string; blockHash: string; logs?: Log[] } | null;
    try {
      receipt = await rpc(chain === "l1" ? config.l1Rpc : config.l2Rpc, "eth_getTransactionReceipt", [hash]) as typeof receipt;
    } catch { continue; }
    if (!receipt?.blockNumber) continue;
    const info: HistoryTransactions = { chain, [chain]: Number(BigInt(receipt.blockNumber)),
      l1Hash: chain === "l1" ? hash : undefined, l2Hashes: chain === "l2" ? [hash] : [] };
    try {
      if (chain === "l2") {
        const settlement = await rpc(config.l2Rpc, "eez_getSettlementByL2Block", [receipt.blockHash]) as Settlement | null;
        if (settlement?.canonicalL2 !== false && settlement?.l2Blocks.some(block => block.hash.toLowerCase() === receipt!.blockHash.toLowerCase())
            && txHash(settlement.l1TransactionHash)) {
          info.l1 = Number(BigInt(settlement.l1BlockNumber));
          info.l1Hash = settlement.l1TransactionHash;
          info.settlement = true;
        }
      } else {
        const ranges = await rpc(config.l2Rpc, "eez_getSettledL2RangesByL1Block", [receipt.blockHash]) as Settlement[] | null;
        const blocks = (ranges ?? []).filter(range => range.canonicalL2 !== false
          && range.l1BlockHash.toLowerCase() === receipt!.blockHash.toLowerCase()).flatMap(range => range.l2Blocks);
        if (!blocks.length) return info;
        const hashes = new Set<string>();
        const emitters = new Set<string>();
        for (const log of receipt.logs ?? []) {
          if (config.rollupsAddress && log.address.toLowerCase() !== config.rollupsAddress.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: eezL1Abi, topics: log.topics, data: log.data });
            if (decoded.eventName === "CrossChainCallExecuted") {
              hashes.add((decoded.args as { crossChainCallHash: string }).crossChainCallHash.toLowerCase());
              emitters.add(log.address);
            }
          } catch { /* Unrelated log. */ }
        }
        if (!hashes.size) return info;
        // Exclude repeated hashes from other origin transactions in the same settled L1 block.
        const origins = await rpc(config.l1Rpc, "eth_getLogs", [{ blockHash: receipt.blockHash,
          address: [...emitters], topics: [outbound, [...hashes]] }]) as Log[];
        for (const key of hashes) {
          const transactions = new Set(origins.filter(log => log.topics[1]?.toLowerCase() === key)
            .map(log => log.transactionHash.toLowerCase()));
          if (transactions.size !== 1 || !transactions.has(hash.toLowerCase())) hashes.delete(key);
        }
        if (!hashes.size) return info;
        const numbers = blocks.map(block => BigInt(block.number));
        const first = numbers.reduce((a, b) => a < b ? a : b);
        const last = numbers.reduce((a, b) => a > b ? a : b);
        const logs = await rpc(config.l2Rpc, "eth_getLogs", [{
          fromBlock: `0x${first.toString(16)}`, toBlock: `0x${last.toString(16)}`,
          address: config.ccmL2Address || "0x4200000000000000000000000000000000000007", topics: [inbound, [...hashes]],
        }]) as Log[];
        const canonical = new Set(blocks.map(block => block.hash.toLowerCase()));
        const matches = new Map<string, Map<string, Log>>();
        for (const log of logs) {
          if (!canonical.has(log.blockHash.toLowerCase()) || !txHash(log.transactionHash)) continue;
          if (log.address.toLowerCase() !== (config.ccmL2Address || "0x4200000000000000000000000000000000000007").toLowerCase()) continue;
          try {
            const event = decodeEventLog({ abi: eezL2Abi, topics: log.topics, data: log.data });
            if (event.eventName !== "IncomingCrossChainCallExecuted") continue;
            const key = (event.args as { crossChainCallHash: string }).crossChainCallHash.toLowerCase();
            if (!hashes.has(key)) continue;
            const transactions = matches.get(key) ?? new Map<string, Log>();
            transactions.set(log.transactionHash.toLowerCase(), log);
            matches.set(key, transactions);
          } catch { /* Malformed or unrelated log. */ }
        }
        for (const transactions of matches.values()) {
          if (transactions.size !== 1) continue;
          const log = [...transactions.values()][0]!;
          if (!info.l2Hashes.includes(log.transactionHash)) info.l2Hashes.push(log.transactionHash);
          info.l2 = Number(BigInt(log.blockNumber));
        }
      }
    } catch { /* Preserve the source receipt while the settlement index catches up. */ }
    return info;
  }
  return null;
}
