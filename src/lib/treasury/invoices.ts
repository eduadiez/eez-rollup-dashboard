import { encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import type { Intent, TreasuryClient } from "./client.ts";
import { allowanceAbi, contractRead, paymentAbi, tokenAbi } from "./payments.ts";

export const invoiceAbi = parseAbi([
  "function token() view returns (address)", "function policyAlias() view returns (address)",
  "function open(bytes32 id,address recipient,uint256 amount)", "function close(bytes32 id)",
  "function accept(bytes32 id,address token,address recipient,uint256 amount)",
  "function invoices(bytes32) view returns (address recipient,uint256 amount,uint8 status)",
  "error InvoiceNotOpen(bytes32 id)",
]);
const nonceAbi = parseAbi(["function nonce() view returns (uint256)"]);
const approvalAbi = parseAbi(["function allowance(address,address) view returns (uint256)"]);
const transferAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
type Anchor = { number: Hex; hash: Hex; timestamp: Hex };
export type InvoiceSnapshot = { l1: Anchor; l2: Anchor; values: Record<string, string | string[]>; invoice: readonly [Address, bigint, number] };
export type InvoiceEvidence = { phase: "open" | "armed" | "executing" | "verified" | "unverified" | "cancelled"; detail: string; mode?: "preparation" | "settlement"; id?: Hex; recipient?: Address; amount?: string;
  intent: Intent; postHash?: Hex; closeHash?: Hex; l1Block?: Hex; l1BlockHash?: Hex;
  before?: { l1: Anchor; l2: Anchor }; after?: { l1: Anchor; l2: Anchor } };
export type Rollback = { postHash: Hex; closeHash: Hex; block: string; before: Record<string, string | string[]>; after: Record<string, string | string[]> };
export type CallFrame = { from?: string; to?: string; input?: Hex; output?: Hex; error?: string; calls?: CallFrame[] };
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Read canonical treasury effects at explicit blocks. Allowance views from an idle
 * L2 block are advanced to the signed epoch exactly as AllowanceModule does. */
export async function invoiceSnapshot(client: TreasuryClient, intent: Intent, anchors?: { l1: Anchor; l2: Anchor }): Promise<InvoiceSnapshot> {
  const c = client.config, p = c.payments!, payment = intent.payment;
  if (payment?.kind !== "invoice" || !p.invoiceMerchant) throw new Error("Missing signed invoice");
  const [l1, l2] = await Promise.all((["l1", "l2"] as const).map(chain =>
    client.rpc<Anchor>(c[chain].rpc, "eth_getBlockByNumber", [anchors?.[chain].number ?? (chain === "l1" ? "latest" : "safe"), false])));
  if (!l1 || !l2) throw new Error("Missing canonical invoice observation");
  if (anchors && (l1.hash !== anchors.l1.hash || l2.hash !== anchors.l2.hash)) throw new Error("Invoice evidence block is no longer canonical");
  const epoch = BigInt(payment.epoch);
  if (BigInt(l1.timestamp) / 600n !== epoch) throw new Error("Invoice evidence crosses its signed budget period");
  const read = (chain: "l1" | "l2", address: Address, abi: readonly unknown[], name: string, args: readonly unknown[] = []) =>
    contractRead(client, chain, address, abi, name, args, chain === "l1" ? l1.number : l2.number);
  const rows: [string, Promise<unknown>][] = [
    ...([["balanceL1", "l1", p.tokenL1, c.safeL1], ["balanceL2", "l2", p.tokenL2, c.safeL2],
      ["recipientL1", "l1", p.tokenL1, payment.recipient], ["recipientL2", "l2", p.tokenL2, payment.recipient],
      ["escrow", "l1", p.tokenL1, p.bridgeL1], ["aliasBalance", "l1", p.tokenL1, p.alias],
      ["policyBalance", "l2", p.tokenL2, p.policy]] as const).map(([key, chain, token, holder]) =>
        [key, read(chain, token, tokenAbi, "balanceOf", [holder])] as [string, Promise<unknown>]),
    ["supply", read("l2", p.tokenL2, tokenAbi, "totalSupply")],
    ["safeNonce", read("l2", c.safeL2, nonceAbi, "nonce")], ["safeL1Nonce", read("l1", c.safeL1, nonceAbi, "nonce")],
    ["spent", read("l2", p.policy, paymentAbi, "spent", [epoch])],
    ["aliasApproval", read("l1", p.tokenL1, approvalAbi, "allowance", [p.alias, p.bridgeL1])],
    ["allowanceL1", read("l1", p.moduleL1, allowanceAbi, "getTokenAllowance", [c.safeL1, p.alias, p.tokenL1])],
    ["allowanceL2", read("l2", p.moduleL2, allowanceAbi, "getTokenAllowance", [c.safeL2, p.policy, p.tokenL2])],
  ];
  const values = Object.fromEntries(await Promise.all(rows.map(async ([key, promise]) => {
    const value = await promise;
    if (!Array.isArray(value)) return [key, String(value)];
    if (value[2] !== 10n || value[3] % 10n !== 0n || value[3] > epoch * 10n) throw new Error("Invoice allowance period mismatch");
    return [key, (value[3] < epoch * 10n ? [value[0], 0n, value[2], epoch * 10n, value[4]] : value).map(String)];
  })));
  const invoice = await read("l1", p.invoiceMerchant, invoiceAbi, "invoices", [payment.invoiceId]) as InvoiceSnapshot["invoice"];
  for (const [chain, anchor] of [["l1", l1], ["l2", l2]] as const) {
    const block = await client.rpc<Anchor>(c[chain].rpc, "eth_getBlockByNumber", [anchor.number, false]);
    if (!block || block.hash !== anchor.hash) throw new Error("Invoice evidence block is no longer canonical");
  }
  return { l1, l2, values, invoice };
}

/** Successful token CALLs must precede the specific merchant error under a common
 * reverted frame. Reverted logs or unchanged balances alone cannot establish this. */
export function invoiceTrace(trace: CallFrame, c: TreasuryClient["config"], intent: Intent) {
  const p = c.payments!, payment = intent.payment;
  if (payment?.kind !== "invoice") throw new Error("Missing invoice intent");
  const rows: { call: CallFrame; ancestors: CallFrame[] }[] = [];
  const visit = (call: CallFrame, ancestors: CallFrame[]) => { rows.push({ call, ancestors }); for (const child of call.calls ?? []) visit(child, [...ancestors, call]); };
  visit(trace, []);
  const transfer = (from: Address, amount: bigint) => rows.findIndex(({ call }) => same(call.to, p.tokenL1) && same(call.from, from)
    && call.input === encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [payment.recipient, amount] })
    && !call.error && !!call.output && BigInt(call.output) === 1n);
  const first = transfer(p.bridgeL1, 10_000_000n), second = transfer(c.safeL1, 100_000_000n);
  const last = rows.findIndex(({ call }) => same(call.to, p.invoiceMerchant) && same(call.from, p.alias)
    && call.input === encodeFunctionData({ abi: invoiceAbi, functionName: "accept", args: [payment.invoiceId, p.tokenL1, payment.recipient, BigInt(payment.amount)] })
    && !!call.error && call.output?.toLowerCase() === `0xa1c43db2${payment.invoiceId.slice(2)}`.toLowerCase());
  if (first < 0 || second <= first || last <= second || !rows[last]!.ancestors.some(frame => frame.error
      && rows[first]!.ancestors.includes(frame) && rows[second]!.ancestors.includes(frame)))
    throw new Error("No common rollback trace for the two transfers followed by InvoiceNotOpen");
}

export async function invoiceControl(c: TreasuryClient["config"], action: string, body: unknown) {
  if (!c.payments?.invoiceControl) throw new Error("Invoice fixture controls are unavailable");
  const response = await fetch(`${c.payments.invoiceControl}/${action}`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Treasury-Instance": c.instance }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Invoice fixture request failed");
  return result;
}
export async function invoiceEvidence(client: TreasuryClient, intent: Intent): Promise<InvoiceEvidence | null> {
  if (!client.config.payments?.invoiceControl || intent.payment?.kind !== "invoice") return null;
  const response = await fetch(`${client.config.payments.invoiceControl}/${intent.payment.invoiceId}`, { headers: { "X-Treasury-Instance": client.config.instance }, signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Invoice evidence is unavailable; settlement remains unresolved");
  return response.json();
}
export async function verifyInvoiceRollback(client: TreasuryClient, intent: Intent, report: InvoiceEvidence): Promise<Rollback> {
  const c = client.config, p = c.payments!, payment = intent.payment;
  if (payment?.kind !== "invoice" || report.phase !== "verified" || report.intent.safeHash !== intent.safeHash
      || report.intent.data !== intent.data || !same(report.intent.sender, intent.sender)
      || report.intent.sourceNonce !== intent.sourceNonce || report.intent.nonce !== intent.nonce
      || !report.before || !report.after || !report.postHash || !report.closeHash) throw new Error("Incomplete invoice rollback evidence");
  const [post, close, trace, before, after, safe] = await Promise.all([
    client.rpc<any>(c.l1.rpc, "eth_getTransactionReceipt", [report.postHash]),
    client.rpc<any>(c.l1.rpc, "eth_getTransactionReceipt", [report.closeHash]),
    client.rpc<CallFrame>(c.l1.rpc, "debug_traceTransaction", [report.postHash, { tracer: "callTracer" }]),
    invoiceSnapshot(client, intent, report.before), invoiceSnapshot(client, intent, report.after),
    client.rpc<Anchor>(c.l2.rpc, "eth_getBlockByNumber", ["safe", false]),
  ]);
  if (!post || !close || close.status !== "0x1" || post.blockHash !== report.l1BlockHash || close.blockHash !== post.blockHash
      || BigInt(close.transactionIndex) >= BigInt(post.transactionIndex) || report.after.l1.hash !== post.blockHash
      || BigInt(safe.number) < BigInt(report.after.l2.number)) throw new Error("Invoice closure and payment are not canonically ordered");
  if (!same(trace.to, c.registry)) throw new Error("Rollback trace is not a protocol posting");
  if (!trace.input?.toLowerCase().includes(intent.safeHash.slice(2).toLowerCase()) || before.values.safeNonce !== intent.nonce)
    throw new Error("Rollback evidence does not bind this Safe authorization");
  invoiceTrace(trace, c, intent);
  if (JSON.stringify(before.values) !== JSON.stringify(after.values) || before.invoice[2] !== 1 || after.invoice[2] !== 3
      || !same(after.invoice[0], payment.recipient) || after.invoice[1] !== BigInt(payment.amount)) throw new Error("Treasury effects did not fully roll back");
  const transaction = await client.rpc<{ to: Address; input: Hex }>(c.l1.rpc, "eth_getTransactionByHash", [report.closeHash]);
  if (!same(transaction?.to, p.invoiceMerchant) || transaction.input !== encodeFunctionData({ abi: invoiceAbi, functionName: "close", args: [payment.invoiceId] }))
    throw new Error("Invoice closure does not match this payment");
  return { postHash: report.postHash, closeHash: report.closeHash, block: String(BigInt(post.blockNumber)), before: before.values, after: after.values };
}
