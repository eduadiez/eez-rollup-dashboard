import { concatHex, encodeFunctionData, getAddress, hashTypedData, isAddress, parseAbi, recoverAddress, size, toHex, zeroAddress } from "viem";
import type { Address, Hex } from "viem";

const safeTypes = {
  EIP712Domain: [{ name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
  SafeTx: [
    { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
  ],
} as const;
for (const fields of Object.values(safeTypes)) {
  for (const field of fields) Object.freeze(field);
  Object.freeze(fields);
}
Object.freeze(safeTypes);

export const safeExecutionAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
]);
export const l1OwnersAbi = parseAbi([
  "function safeL1() view returns (address)",
  "function safeL1Proxy() view returns (address)",
  "function manager() view returns (address)",
  "function isValidSignature(bytes data,bytes signatures) view returns (bytes4)",
]);

function address(value: string, name: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`Invalid ${name}`);
  return getAddress(value);
}
function uint256(value: bigint, name: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n) throw new Error(`Invalid ${name}`);
  return value;
}
function bytes(value: string): asserts value is Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("Invalid calldata bytes");
}

/** Immutable review/signing data for a zero-value Safe transaction.
 * Payments use Call on the selected source Safe domain. Setup and internal transfers use DelegateCall to the
 * verified Safe MultiSendCallOnly for an atomic batch.
 * Zero safeTxGas and gasPrice make a required inner failure revert the Safe nonce too.
 * These fields do not waive the submitter's network fee.
 */
export function buildSafeTransaction(input: { chainId: bigint; safe: Address; to: Address; data: Hex; nonce: bigint; operation?: 0 | 1 }) {
  const chainId = uint256(input.chainId, "chain ID");
  if (chainId === 0n) throw new Error("Invalid chain ID");
  bytes(input.data);
  if (input.operation !== undefined && input.operation !== 0 && input.operation !== 1) throw new Error("Invalid Safe operation");
  return Object.freeze({
    domain: Object.freeze({ chainId, verifyingContract: address(input.safe, "Safe") }),
    types: safeTypes,
    primaryType: "SafeTx" as const,
    message: Object.freeze({
      to: address(input.to, "target"), value: 0n, data: input.data, operation: input.operation ?? 0,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress,
      nonce: uint256(input.nonce, "Safe nonce"),
    }),
  });
}
export type ReviewedSafeTransaction = ReturnType<typeof buildSafeTransaction>;
export const safeTransactionHash = (transaction: ReviewedSafeTransaction): Hex => hashTypedData(transaction);

/** JSON for eth_signTypedData_v4; large integers remain exact decimal strings. */
export function safeTypedDataJSON(transaction: ReviewedSafeTransaction): string {
  return JSON.stringify(transaction, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

/** Check EOA typed-data approvals against the supplied owner snapshot, then pack the
 * single legacy contract-owner signature expected by Safe v1.3.0 / v1.4.1. Snapshot checks are
 * advisory: re-read the nonce/owners before submission; the L1 Safe verifies them again.
 * This initial wallet path deliberately accepts EIP-712 EOA signatures only.
 */
export async function packOwnerApprovals(transaction: ReviewedSafeTransaction, adapter: Address,
  owners: readonly Address[], threshold: number, approvals: readonly { owner: Address; signature: Hex }[]): Promise<Hex> {
  const contractOwner = address(adapter, "owner adapter");
  const inner = await packEOAApprovals(transaction, owners, threshold, approvals);
  return concatHex([toHex(BigInt(contractOwner), { size: 32 }), toHex(65, { size: 32 }), "0x00",
    toHex(size(inner), { size: 32 }), inner]);
}

/** Standard Safe EOA signatures, also used for ordinary L1 owner administration. */
export async function packEOAApprovals(transaction: ReviewedSafeTransaction,
  owners: readonly Address[], threshold: number, approvals: readonly { owner: Address; signature: Hex }[]): Promise<Hex> {
  const ownerSet = new Set(owners.map(owner => address(owner, "L1 owner").toLowerCase()));
  if (ownerSet.size !== owners.length || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length)
    throw new Error("Invalid owner set or threshold");
  if (approvals.length < threshold || approvals.length > owners.length) throw new Error("Incomplete or invalid owner quorum");
  const seen = new Set<string>();
  const hash = safeTransactionHash(transaction);
  const validated: { owner: Address; signature: Hex }[] = [];
  for (const approval of approvals.map(item => ({ ...item }))) {
    const owner = address(approval.owner, "signer");
    const key = owner.toLowerCase();
    if (!ownerSet.has(key) || seen.has(key)) throw new Error("Unknown or duplicate owner");
    bytes(approval.signature);
    if (size(approval.signature) !== 65 || !/1[bBcC]$/.test(approval.signature)) throw new Error("Expected a 65-byte EOA typed-data signature");
    const recovered = await recoverAddress({ hash, signature: approval.signature });
    if (recovered.toLowerCase() !== key) throw new Error("Signature does not approve this Safe transaction");
    seen.add(key); validated.push({ owner, signature: approval.signature });
  }
  validated.sort((a, b) => BigInt(a.owner) < BigInt(b.owner) ? -1 : 1);
  return concatHex(validated.map(approval => approval.signature));
}

/** Encode the reviewed transaction without changing any signed field. */
export function encodeSafeExecution(transaction: ReviewedSafeTransaction, signatures: Hex): Hex {
  bytes(signatures);
  const tx = transaction.message;
  return encodeFunctionData({ abi: safeExecutionAbi, functionName: "execTransaction", args: [
    tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures,
  ] });
}
