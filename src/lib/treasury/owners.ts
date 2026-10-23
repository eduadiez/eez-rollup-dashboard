import { decodeSafeExecution, safeExecutionTopics } from "./safeEvents.ts";
import { encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import { safeAbi } from "./client.ts";
import type { Approval, TreasuryClient } from "./client.ts";
import { buildSafeTransaction, encodeSafeExecution, packEOAApprovals, safeTransactionHash, safeTypedDataJSON } from "./safeTransactions.ts";
import type { ReviewedSafeTransaction } from "./safeTransactions.ts";

const adminAbi = parseAbi(["function addOwnerWithThreshold(address owner,uint256 threshold)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const digest = (s: unknown): s is Hex => typeof s === "string" && /^0x[\da-f]{64}$/i.test(s);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
type OwnerState = { owners: Address[]; threshold: number; nonce: bigint; block: Hex; fingerprint: string };
export type OwnerReview = { candidate: Address; threshold: number; before: OwnerState; transaction: ReviewedSafeTransaction };
export type OwnerSubmission = { version: 1; instance: string; candidate: Address; threshold: number; nonce: string;
  safeHash: Hex; sender: Address; sourceNonce: Hex; startBlock: Hex; data: Hex; hash?: Hex };

export async function l1OwnerState(client: TreasuryClient, tag = "latest"): Promise<OwnerState> {
  const c = client.config;
  const block = await client.rpc<{ number: Hex; hash: Hex }>(c.l1.rpc, "eth_getBlockByNumber", [tag, false]);
  check(block, "L1 owner state unavailable");
  const [owners, threshold, nonce] = await Promise.all([
    client.read(c.l1.rpc, c.safeL1, safeAbi, "getOwners", block.number),
    client.read(c.l1.rpc, c.safeL1, safeAbi, "getThreshold", block.number),
    client.read(c.l1.rpc, c.safeL1, safeAbi, "nonce", block.number),
  ]);
  const again = await client.rpc<{ hash: Hex }>(c.l1.rpc, "eth_getBlockByNumber", [block.number, false]);
  check(again?.hash === block.hash, "L1 changed while reading owners");
  const sorted = (owners as Address[]).map(owner => getAddress(owner)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { owners: sorted, threshold: Number(threshold), nonce: nonce as bigint, block: block.number,
    fingerprint: `${threshold}:${sorted.join(",").toLowerCase()}` };
}
export function ownerAddition(client: TreasuryClient, candidate: Address, threshold: number, before: OwnerState): OwnerReview {
  const c = client.config;
  check(isAddress(candidate) && BigInt(candidate) > 1n && !same(candidate, c.safeL1)
    && !before.owners.some(owner => same(owner, candidate)), "Enter a valid wallet address that is not already an L1 owner");
  check(Number.isSafeInteger(threshold) && threshold > 0 && threshold <= before.owners.length + 1, "Invalid new threshold");
  return { candidate: getAddress(candidate), threshold, before: { ...before, owners: [...before.owners] },
    transaction: buildSafeTransaction({ chainId: BigInt(c.l1.chainId), safe: c.safeL1, to: c.safeL1, nonce: before.nonce,
      data: encodeFunctionData({ abi: adminAbi, functionName: "addOwnerWithThreshold", args: [candidate, BigInt(threshold)] }) }) };
}
async function current(client: TreasuryClient, review: OwnerReview) {
  const now = await l1OwnerState(client);
  check(now.fingerprint === review.before.fingerprint && now.nonce === review.before.nonce, "L1 owners or nonce changed. Review the owner addition again.");
  return now;
}
async function wallet(client: TreasuryClient, provider: EthereumProvider, expected?: Address) {
  const c = client.config;
  const [accounts, id] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
  const sender = (accounts as Address[])[0];
  check(sender && (!expected || same(sender, expected)), "Wallet account changed");
  check(BigInt(id as string) === BigInt(c.l1.chainId), "Switch to the L1 network to manage owners");
  const reference = await provider.request({ method: "eth_getBlockByNumber", params: [c.l1.checkpoint?.number ?? "0x0", false] }) as { hash: Hex } | null;
  check(reference && same(reference.hash, c.l1.checkpoint?.hash ?? c.l1.genesis!), "Wallet L1 network does not match this treasury");
  const binding = c.code.find(b => b.chain === "l1" && same(b.address, c.safeL1));
  const code = await provider.request({ method: "eth_getCode", params: [c.safeL1, "latest"] }) as Hex;
  check(binding && keccak256(code) === binding.hash, "Wallet L1 Safe code does not match this treasury");
  return getAddress(sender);
}
export async function approveOwnerAddition(client: TreasuryClient, provider: EthereumProvider, review: OwnerReview): Promise<Approval> {
  await client.validate();
  await current(client, review);
  const owner = await wallet(client, provider);
  check(review.before.owners.some(a => same(a, owner)), "Only a current L1 owner can approve adding an owner");
  const signature = await provider.request({ method: "eth_signTypedData_v4", params: [owner, safeTypedDataJSON(review.transaction)] }) as Hex;
  await wallet(client, provider, owner);
  await current(client, review);
  await packEOAApprovals(review.transaction, review.before.owners, 1, [{ owner, signature }]);
  return { owner, signature };
}
export async function prepareOwnerAddition(client: TreasuryClient, provider: EthereumProvider, review: OwnerReview, approvals: Approval[]) {
  await client.validate();
  await current(client, review);
  const sender = await wallet(client, provider);
  const signatures = await packEOAApprovals(review.transaction, review.before.owners, review.before.threshold, approvals);
  const data = encodeSafeExecution(review.transaction, signatures), c = client.config;
  const sourceNonce = await client.rpc<Hex>(c.l1.rpc, "eth_getTransactionCount", [sender, "pending"]);
  const request = { from: sender, to: c.safeL1, chainId: toHex(c.l1.chainId), value: "0x0", nonce: sourceNonce, data };
  const gas = await client.rpc<Hex>(c.l1.rpc, "eth_estimateGas", [request]);
  const pending: OwnerSubmission = { version: 1, instance: c.instance, candidate: review.candidate, threshold: review.threshold,
    nonce: String(review.before.nonce), safeHash: safeTransactionHash(review.transaction), sender, sourceNonce,
    startBlock: review.before.block, data };
  return { pending, request: { ...request, gas: toHex(BigInt(gas) * 120n / 100n) } };
}
export function readOwnerSubmission(client: TreasuryClient, text: string | null): OwnerSubmission | null {
  if (!text) return null;
  const p = JSON.parse(text) as OwnerSubmission, c = client.config;
  check(p.version === 1 && p.instance === c.instance && isAddress(p.candidate) && isAddress(p.sender) && digest(p.safeHash)
    && (!p.hash || digest(p.hash)) && /^\d{1,78}$/.test(p.nonce) && /^0x[\da-f]+$/i.test(p.startBlock)
    && /^0x[\da-f]+$/i.test(p.sourceNonce) && /^0x(?:[\da-f]{2})+$/i.test(p.data)
    && Number.isSafeInteger(p.threshold) && p.threshold > 0, "Invalid saved owner submission; retain its wallet hash for recovery");
  const tx = buildSafeTransaction({ chainId: BigInt(c.l1.chainId), safe: c.safeL1, to: c.safeL1, nonce: BigInt(p.nonce),
    data: encodeFunctionData({ abi: adminAbi, functionName: "addOwnerWithThreshold", args: [p.candidate, BigInt(p.threshold)] }) });
  check(safeTransactionHash(tx) === p.safeHash, "Saved owner addition belongs to another Safe or transaction");
  return p;
}
/** Completion records canonical inclusion. Recheck the receipt after reading
 * the resulting owners so a reorg during those reads cannot complete the change. */
export async function ownerAdditionOutcome(client: TreasuryClient, pending: OwnerSubmission) {
  const c = client.config;
  let hash = pending.hash;
  if (!hash) {
    const logs = await client.rpc<{ address: Address; transactionHash: Hex; data: Hex; topics: Hex[] }[]>(c.l1.rpc, "eth_getLogs", [{ address: c.safeL1,
      fromBlock: pending.startBlock, toBlock: "latest", topics: [safeExecutionTopics] }]);
    hash = logs.find(log => same(log.address, c.safeL1) && decodeSafeExecution(log)?.args.txHash === pending.safeHash)?.transactionHash;
  }
  if (!hash) return { complete: false, detail: "Waiting for the wallet transaction. This owner change will not be resubmitted automatically." };
  const receipt = await client.rpc<{ status: Hex; blockNumber: Hex; blockHash: Hex; logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[] } | null>(c.l1.rpc, "eth_getTransactionReceipt", [hash]);
  if (!receipt) return { complete: false, hash, detail: "Owner change submitted; waiting for L1 confirmation." };
  check(["0x0", "0x1"].includes(receipt.status) && /^0x[\da-f]+$/i.test(receipt.blockNumber)
    && digest(receipt.blockHash), "Incomplete owner transaction receipt");
  const [block, tx] = await Promise.all([
    client.rpc<{ number: Hex; hash: Hex }>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    client.rpc<{ from: Address; to: Address; input: Hex; nonce: Hex }>(c.l1.rpc, "eth_getTransactionByHash", [hash]),
  ]);
  check(tx && same(tx.from, pending.sender) && same(tx.to, c.safeL1) && same(tx.input, pending.data)
    && BigInt(tx.nonce) === BigInt(pending.sourceNonce), "Owner transaction does not match the saved request");
  if (!block || block.hash !== receipt.blockHash || block.number !== receipt.blockNumber)
    return { complete: false, hash, detail: "Checking L1 inclusion again." };
  if (receipt.status === "0x1") {
    const success = receipt.logs.some(log => {
      if (!same(log.address, c.safeL1)) return false;
      const event = decodeSafeExecution(log);
      return event?.eventName === "ExecutionSuccess" && event.args.txHash === pending.safeHash;
    });
    const after = await l1OwnerState(client, receipt.blockNumber);
    check(success && after.owners.some(owner => same(owner, pending.candidate)) && after.threshold === pending.threshold,
      "L1 receipt does not establish the requested owner change");
  }
  const [checkedReceipt, checkedBlock] = await Promise.all([
    client.rpc<{ status: Hex; blockNumber: Hex; blockHash: Hex } | null>(c.l1.rpc, "eth_getTransactionReceipt", [hash]),
    client.rpc<{ number: Hex; hash: Hex } | null>(c.l1.rpc, "eth_getBlockByNumber", [receipt.blockNumber, false]),
  ]);
  if (!checkedReceipt || !checkedBlock || checkedReceipt.blockNumber !== receipt.blockNumber
    || checkedReceipt.blockHash !== receipt.blockHash || checkedReceipt.status !== receipt.status
    || checkedBlock.number !== receipt.blockNumber || checkedBlock.hash !== receipt.blockHash)
    return { complete: false, hash, detail: "Checking L1 inclusion again." };
  return { complete: true, success: receipt.status === "0x1", hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    detail: receipt.status === "0x1" ? "Owner added on L1. EEZ-X reads the updated owner set for subsequent payments." : "The L1 owner change reverted." };
}
