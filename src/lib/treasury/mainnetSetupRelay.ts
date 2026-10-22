import { decodeEventLog, encodeEventTopics, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { DeploymentPending } from "./deployment.ts";
import type { DeploymentIO } from "./deploymentIO.ts";
import { transferAbi } from "./transfers.ts";
import network from "./mainnet-network.json" with { type: "json" };

type Log = { address: Address; topics: [Hex, ...Hex[]]; data: Hex; blockHash: Hex; blockNumber: Hex; transactionHash: Hex };
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function event(log: Pick<Log, "address" | "topics" | "data">, address: string, name: string) {
  if (!same(log.address, address)) return;
  try { const e = decodeEventLog({ abi: transferAbi, ...log }); if (e.eventName === name) return e.args as Record<string, unknown>; } catch { /* Other events. */ }
}
/** Setup completion requires the exact incoming call and canonical L1 inclusion.
 * The signature hash alone does not establish which source transaction consumed it. */
export async function findIncomingCall(io: Pick<DeploymentIO, "rpc">, safe: Address, p: DeploymentPending,
  source: { blockHash: Hex; blockNumber: Hex; logs: Pick<Log, "address" | "topics" | "data">[] }) {
  const calls = source.logs.flatMap(l => { const e = event(l, network.registry, "CrossChainCallExecuted");
    return e && same(e.proxy, p.to) && same(e.sourceAddress, p.sender) && same(e.callData, p.data) && e.value === 0n ? [e] : []; });
  if (calls.length !== 1) throw new Error("Missing unique mirror setup source call");
  const callHash = calls[0]!.crossChainCallHash as Hex;
  const safeHead = await io.rpc<{ number: Hex }>("l2", "eth_getBlockByNumber", ["safe", false]);
  const high = BigInt(safeHead.number), low = high > 4096n ? high - 4096n : 0n;
  const incoming = await io.rpc<Log[]>("l2", "eth_getLogs", [{ address: network.manager, fromBlock: toHex(low), toBlock: safeHead.number,
    topics: encodeEventTopics({ abi: transferAbi, eventName: "IncomingCrossChainCallExecuted", args: { crossChainCallHash: callHash } }) }]);
  for (const log of incoming) {
    const e = event(log, network.manager, "IncomingCrossChainCallExecuted");
    if (!e || e.isStatic !== false || e.sourceRollup !== 0n || e.value !== 0n || !same(e.destination, safe) || !same(e.sourceAddress, p.sender) || !same(e.data, p.data)) continue;
    const settlement = await io.rpc<{ canonicalL2: boolean; l1BlockHash: Hex; l1BlockNumber: Hex; l2Blocks: { number: Hex; hash: Hex }[] }>("l2", "eez_getSettlementByL2Block", [log.blockHash], true);
    if (!settlement?.canonicalL2 || settlement.l1BlockHash !== source.blockHash || BigInt(settlement.l1BlockNumber) !== BigInt(source.blockNumber)
      || !settlement.l2Blocks.some(b => b.hash === log.blockHash && BigInt(b.number) === BigInt(log.blockNumber))) continue;
    const receipt = await io.rpc<{ status: Hex; blockHash: Hex; logs: Log[] }>("l2", "eth_getTransactionReceipt", [log.transactionHash]);
    const [block, anchor] = await Promise.all([io.rpc<{ hash: Hex }>("l2", "eth_getBlockByNumber", [log.blockNumber, false]),
      io.rpc<{ hash: Hex }>("l1", "eth_getBlockByNumber", [source.blockNumber, false])]);
    if (receipt?.status === "0x1" && receipt.blockHash === log.blockHash && block?.hash === log.blockHash && anchor?.hash === source.blockHash) return receipt.logs;
  }
  return null;
}
