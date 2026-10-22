import { toHex } from "viem";
import type { Hex } from "viem";
import type { Intent, Outcome, TreasuryClient } from "./client.ts";

type Block = { number: Hex; hash: Hex };
type Settlement = { canonicalL2: boolean; l1TransactionHash: Hex; l1BlockHash: Hex; l1BlockNumber: Hex; l2Blocks: Block[] };
export type TreasurySettlement = { l1Transaction: Hex; l1Block: string; l2Block: string };
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);

/** Optional explorer evidence, independent of payment acceptance. An unavailable
 * index must not undo a verified payment; a stale index must not produce links. */
export async function treasurySettlement(client: TreasuryClient, outcome: Outcome): Promise<TreasurySettlement | null> {
  if (outcome.kind !== "settled" || !outcome.block || !outcome.execution?.l2) return null;
  const c = client.config, number = toHex(BigInt(outcome.block));
  const receipt = await client.rpc<{ status: Hex; blockHash: Hex; blockNumber: Hex } | null>(c.l2.rpc, "eth_getTransactionReceipt", [outcome.execution.l2]);
  const block = await client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [number, false]);
  if (!receipt || receipt.status !== "0x1" || BigInt(receipt.blockNumber) !== BigInt(number) || !same(receipt.blockHash, block?.hash)) return null;
  const record = await client.rpc<Settlement | null>(c.l2.front, "eez_getSettlementByL2Block", [receipt.blockHash]);
  if (!record || record.canonicalL2 !== true || !hash(record.l1TransactionHash) || !hash(record.l1BlockHash)
      || !Array.isArray(record.l2Blocks) || !record.l2Blocks.some(b => same(b.hash, receipt.blockHash) && BigInt(b.number) === BigInt(number))) return null;
  const [post, anchor, again] = await Promise.all([
    client.rpc<{ status: Hex; transactionHash: Hex; blockHash: Hex; blockNumber: Hex } | null>(c.l1.rpc, "eth_getTransactionReceipt", [record.l1TransactionHash]),
    client.rpc<Block | null>(c.l1.rpc, "eth_getBlockByNumber", [record.l1BlockNumber, false]),
    client.rpc<Block | null>(c.l2.rpc, "eth_getBlockByNumber", [number, false]),
  ]);
  if (!post || post.status !== "0x1" || !same(post.transactionHash, record.l1TransactionHash) || !same(post.blockHash, record.l1BlockHash)
      || BigInt(post.blockNumber) !== BigInt(record.l1BlockNumber) || !same(anchor?.hash, record.l1BlockHash) || !same(again?.hash, receipt.blockHash)) return null;
  return { l1Transaction: record.l1TransactionHash, l1Block: String(BigInt(record.l1BlockNumber)), l2Block: outcome.block };
}

/** The execution identity, rather than the polling timestamp, owns link evidence. */
export function settlementIdentity(outcome?: Outcome | null): string | undefined {
  return outcome?.kind === "settled" && outcome.execution?.l2 && outcome.block
    ? `${outcome.execution.l2}:${outcome.block}` : undefined;
}

export type TreasuryTransactionLink = { chain: "l1" | "l2"; hash: Hex; block?: string; role: "execution" | "settlement" };
export function treasuryTransactions(intent?: Intent, outcome?: Outcome | null, settlement?: TreasurySettlement | null): TreasuryTransactionLink[] {
  if (!intent) return [];
  const source = intent.submissionChain ?? intent.payment?.source ?? "l2", hash = outcome?.hash ?? intent.hash;
  const links: TreasuryTransactionLink[] = [];
  const l1 = outcome?.execution?.l1 ?? (source === "l1" ? hash : undefined);
  const l2 = outcome?.execution?.l2 ?? (source === "l2" ? hash : undefined);
  if (l1) links.push({ chain: "l1", hash: l1, block: outcome?.sourceBlock, role: "execution" });
  const post = settlement?.l1Transaction ?? outcome?.rollback?.postHash;
  const postBlock = settlement?.l1Block ?? outcome?.rollback?.block;
  if (post) {
    const existing = links.find(link => link.hash.toLowerCase() === post.toLowerCase());
    if (existing) existing.block ??= postBlock;
    else links.push({ chain: "l1", hash: post, block: postBlock, role: "settlement" });
  }
  if (l2) links.push({ chain: "l2", hash: l2, block: outcome?.block, role: "execution" });
  return links;
}
