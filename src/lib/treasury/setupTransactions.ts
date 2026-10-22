import type { Hex } from "viem";
import type { Chain, DeploymentState, TreasuryDeployment } from "./deployment.ts";

export type SetupInclusion = { blockNumber: Hex; blockHash: Hex };
export type SetupTransaction = {
  id: string; label: string; chain: Chain; hash?: Hex; completed: boolean; inclusion?: SetupInclusion;
};
export type SetupObservation = {
  status: "pending" | "included" | "failed" | "rechecking" | "unavailable";
  blockNumber?: Hex; blockHash?: Hex; timestamp?: number; detail?: string;
};
type Block = { number: Hex; hash: Hex; timestamp?: Hex };
type Receipt = { status: Hex; blockNumber: Hex; blockHash: Hex };
type Reader = Pick<TreasuryDeployment, "rpc">;
const quantity = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]+$/i.test(value);
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);

/** Journal order is the setup order, including retained steps from older plans. */
export function setupTransactions(d: Pick<TreasuryDeployment, "steps">, state: DeploymentState): SetupTransaction[] {
  const plan = d.steps(state);
  const records: SetupTransaction[] = state.completed.map((id, index) => ({ id, label: plan[index]!.label,
    chain: plan[index]!.chain, hash: state.transactions[index]!, completed: true, inclusion: state.inclusions?.[state.transactions[index]!] }));
  if (state.pending) records.push({ id: state.pending.id, label: plan[state.completed.length]!.label,
    chain: state.pending.chain, hash: state.pending.hash, completed: false });
  return records;
}

/** Inclusion is established by a receipt and its current canonical block, never
 * by saved progress or a head height alone. Finality is a separate observation.
 */
export async function observeSetupTransaction(d: Reader, tx: SetupTransaction): Promise<SetupObservation> {
  if (!tx.hash) return { status: "pending", detail: "Waiting for the wallet transaction." };
  try {
    const receipt = await d.rpc<Receipt | null>(tx.chain, "eth_getTransactionReceipt", [tx.hash]);
    if (!receipt) return { status: tx.completed ? "rechecking" : "pending", detail: "Waiting for a canonical receipt." };
    if (!quantity(receipt.blockNumber) || !hash(receipt.blockHash) || !["0x0", "0x1"].includes(receipt.status))
      throw new Error("Incomplete transaction receipt");
    const block = await d.rpc<Block | null>(tx.chain, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!block || block.hash !== receipt.blockHash || block.number !== receipt.blockNumber)
      return { status: "rechecking", detail: "The transaction block is no longer canonical. Checking again." };
    if (tx.inclusion && (tx.inclusion.blockHash !== receipt.blockHash || tx.inclusion.blockNumber !== receipt.blockNumber))
      return { status: "rechecking", detail: "This completed transaction moved to another block. Its setup effects need revalidation." };
    return { status: receipt.status === "0x1" ? "included" : "failed", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      ...(quantity(block.timestamp) ? { timestamp: Number(BigInt(block.timestamp)) * 1000 } : {}) };
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Later wallet actions must not depend on an orphaned setup transaction.
 * Keep the journal intact: a missing receipt is not permission to resend.
 */
export async function assertSetupProgress(d: Reader & Pick<TreasuryDeployment, "steps">, state: DeploymentState) {
  const completed = setupTransactions(d, state).filter(tx => tx.completed);
  for (let offset = 0; offset < completed.length; offset += 4) await Promise.all(completed.slice(offset, offset + 4).map(async tx => {
    const observation = await observeSetupTransaction(d, tx);
    if (observation.status !== "included") throw new Error(`Recheck ${tx.label} before continuing. ${observation.detail ?? "The transaction failed."}`);
  }));
}
