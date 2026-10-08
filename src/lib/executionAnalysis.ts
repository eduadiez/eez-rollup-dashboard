import { decodeAbiParameters } from "viem";
import { isDebugManager, jsonDebug, transactionHashes, type CallTrace, type DebugContext, type DebugEvent, type DebugTransaction } from "./executionDebugger";

export const txKey = (tx: DebugTransaction) => `${tx.chain}:${tx.tx.hash.toLowerCase()}`;
export const isEezTransaction = (tx: DebugTransaction): boolean =>
  isDebugManager(tx.chain, tx.tx.to) || !!tx.payload || tx.events.some(event => event.protocol);
const hashValue = (value: unknown): string | null => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value) ? value.toLowerCase() : null;
const eq = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
const idx = (event: DebugEvent) => String(event.args.entryQueueIndex ?? event.args.entryIndex ?? "");
export type EntryPlan = { id: string; tx: DebugTransaction; entry: Record<string, unknown>; index: number; kind: "Execution" | "Static"; hash: string | null };
export type ExecutionOccurrence = { id: string; tx: DebugTransaction; event: DebugEvent; eventIndex: number; entryIndex: string; role: "Outgoing" | "Incoming" | "Consumed" };
export type ExecutionPair = { hash: string; plans: EntryPlan[]; occurrences: ExecutionOccurrence[]; ambiguous: boolean; direction: string };
export type EvidenceState = "Match" | "Mismatch" | "Missing evidence" | "Ambiguous" | "Skipped";
export type EvidenceCheck = { field: string; expected: unknown; observed?: unknown; state: EvidenceState; detail?: string };
export type EntryEvidence = { plan: EntryPlan; state: EvidenceState; checks: EvidenceCheck[]; observations: ExecutionOccurrence[] };

export function contextTransactions(context: DebugContext): DebugTransaction[] {
  const transactions = context.blocks.flatMap(block => block.transactions);
  if (context.selected && !transactions.some(tx => txKey(tx) === txKey(context.selected!))) transactions.push(context.selected);
  return [...new Map(transactions.map(tx => [txKey(tx), tx])).values()].sort((a, b) => {
    if (a.chain !== b.chain) return a.chain === "l1" ? -1 : 1;
    const block = BigInt(a.tx.blockNumber ?? 0) - BigInt(b.tx.blockNumber ?? 0);
    return block ? block > 0n ? 1 : -1 : Number(BigInt(a.tx.transactionIndex ?? 0) - BigInt(b.tx.transactionIndex ?? 0));
  });
}

// A block can contain unrelated L1 transactions. They remain in the raw context,
// but must not determine this selected batch's execution status.
function executionTransactions(context: DebugContext): DebugTransaction[] {
  const transactions = contextTransactions(context);
  const selected = context.selected;
  if (!selected || selected.chain !== "l1" || selected.payload?.method !== "postAndVerifyBatch") return transactions;
  const hashes = transactionHashes(selected);
  return transactions.filter(tx => tx.chain === "l2" || txKey(tx) === txKey(selected) || [...transactionHashes(tx)].some(hash => hashes.has(hash)));
}

export function executionPlans(tx: DebugTransaction): EntryPlan[] {
  const table = tx.events.find(event => event.protocol && event.name === "ExecutionTableLoaded");
  const entries = tx.payload?.entries.length ? tx.payload.entries : (table?.args.entries ?? []) as Record<string, unknown>[];
  const statics = tx.payload?.staticEntries.length ? tx.payload.staticEntries : (table?.args.staticEntries ?? []) as Record<string, unknown>[];
  return [...entries.map((entry, index) => ({ entry, index, kind: "Execution" as const })), ...statics.map((entry, index) => ({ entry, index, kind: "Static" as const }))]
    .map(plan => ({ ...plan, tx, id: `${txKey(tx)}:${plan.kind}:${plan.index}`, hash: hashValue(plan.entry.proxyEntryHash) }));
}

export function buildExecutionPairs(context: DebugContext): ExecutionPair[] {
  const groups = new Map<string, ExecutionPair>();
  const group = (hash: string) => {
    if (!groups.has(hash)) groups.set(hash, { hash, plans: [], occurrences: [], ambiguous: false, direction: "Cross-chain execution" });
    return groups.get(hash)!;
  };
  for (const tx of executionTransactions(context)) {
    for (const plan of executionPlans(tx)) if (plan.hash) group(plan.hash).plans.push(plan);
    tx.events.filter(event => event.protocol).forEach((event, eventIndex) => {
      const hash = hashValue(event.args.crossChainCallHash);
      const role = event.name === "CrossChainCallExecuted" ? "Outgoing" : event.name === "IncomingCrossChainCallExecuted" ? "Incoming" : event.name === "ExecutionConsumed" ? "Consumed" : null;
      if (hash && role) group(hash).occurrences.push({ id: `${txKey(tx)}:${eventIndex}`, tx, event, eventIndex, entryIndex: idx(event), role });
    });
  }
  for (const pair of groups.values()) {
    const outgoing = pair.occurrences.filter(item => item.role === "Outgoing");
    const directions = new Set(outgoing.map(item => item.tx.chain === "l1" ? "L1 → L2" : "L2 → L1"));
    if (directions.size) pair.direction = [...directions].join(" / ");
    pair.ambiguous = (["l1", "l2"] as const).some(chain => ["Consumed", "Outgoing", "Incoming"].some(role => pair.occurrences.filter(item => item.tx.chain === chain && item.role === role).length > 1));
  }
  return [...groups.values()];
}

export function eventCallHash(tx: DebugTransaction, eventIndex: number): string | null {
  const events = tx.events.filter(event => event.protocol);
  const event = events[eventIndex];
  if (!event) return null;
  const direct = hashValue(event.args.crossChainCallHash);
  if (direct) return direct;
  if (!idx(event)) return null;
  for (let i = eventIndex - 1; i >= 0; i--) {
    const previous = events[i]!;
    if (previous.name === "ExecutionConsumed" && idx(previous) === idx(event)) return hashValue(previous.args.crossChainCallHash);
  }
  return null;
}

function completion(occurrence: ExecutionOccurrence): DebugEvent | undefined {
  const events = occurrence.tx.events.filter(event => event.protocol);
  for (let i = occurrence.eventIndex + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.name === "ExecutionConsumed" && idx(event) === occurrence.entryIndex) return undefined;
    if (event.name === "EntryExecuted" && idx(event) === occurrence.entryIndex) return event;
  }
  return undefined;
}

export function compareExecution(context: DebugContext, traces: Record<string, CallTrace> = {}): EntryEvidence[] {
  const transactions = executionTransactions(context);
  const pairs = buildExecutionPairs(context);
  const plans = transactions.flatMap(executionPlans);
  return plans.map(plan => {
    let observations = plan.hash ? pairs.find(pair => pair.hash === plan.hash)?.occurrences.filter(item => item.tx.chain === plan.tx.chain && item.role === "Consumed" &&
      (BigInt(item.tx.tx.blockNumber ?? 0) > BigInt(plan.tx.tx.blockNumber ?? 0) || (item.tx.tx.blockNumber === plan.tx.tx.blockNumber && BigInt(item.tx.tx.transactionIndex ?? 0) >= BigInt(plan.tx.tx.transactionIndex ?? 0)))) ?? [] : [];
    let done: DebugEvent | undefined;
    let ambiguous = false;
    // L2 tables are replaced per system load. Associate an index only with its
    // latest preceding load on that chain, not an unrelated table in the block.
    if (plan.tx.chain === "l2") observations = observations.filter(item => {
      const precedingLoads = transactions.filter(tx => tx.chain === "l2" && executionPlans(tx).length && tx.tx.blockNumber === item.tx.tx.blockNumber &&
        BigInt(tx.tx.transactionIndex ?? 0) <= BigInt(item.tx.tx.transactionIndex ?? 0));
      const preceding = precedingLoads[precedingLoads.length - 1];
      return preceding && txKey(preceding) === txKey(plan.tx) && item.entryIndex === String(plan.index);
    });
    const candidates = observations.map(item => ({ item, done: completion(item) }));
    const exact = candidates.filter(item => item.done && eq(item.done.args.rollingHash, plan.entry.rollingHash));
    const duplicatePlans = plans.filter(other => other.tx.chain === plan.tx.chain && other.hash === plan.hash && other.kind === plan.kind && other.id !== plan.id && (plan.tx.chain === "l1" || txKey(other.tx) === txKey(plan.tx)));
    if (plan.kind === "Static") observations = [];
    else if (exact.length === 1 && !duplicatePlans.some(other => eq(other.entry.rollingHash, plan.entry.rollingHash))) { done = exact[0]!.done; observations = [exact[0]!.item]; }
    else if (candidates.length === 1 && !duplicatePlans.length) { done = candidates[0]!.done; observations = [candidates[0]!.item]; }
    else if (candidates.length) ambiguous = true;
    if (!plan.hash && plan.kind === "Execution") {
      const immediate = plan.tx.events.filter(event => event.protocol && event.name === "EntryExecuted");
      const matching = immediate.filter(event => eq(event.args.rollingHash, plan.entry.rollingHash));
      if (matching.length === 1 && !plans.some(other => other.id !== plan.id && txKey(other.tx) === txKey(plan.tx) && eq(other.entry.rollingHash, plan.entry.rollingHash))) done = matching[0];
      else if (immediate.length) ambiguous = true;
    }
    const skipped = plan.kind === "Execution" && plan.tx.events.find(event => event.protocol && event.name === "L2TxSkipped" && idx(event) === String(plan.index));
    const trace = traces[txKey(plan.tx)];
    // Only the incoming entrypoint's one root entry has a direct, ABI-defined
    // bytes result. A batch transaction's receipt status is not an entry result.
    const directTrace = trace && plan.kind === "Execution" && plan.index === 0 && plan.tx.payload?.method === "executeIncomingCrossChainCall" ? trace : undefined;
    let returned: string | undefined;
    if (directTrace?.error) returned = directTrace.output;
    else if (directTrace?.output) {
      try { returned = decodeAbiParameters([{ type: "bytes" }], directTrace.output as `0x${string}`)[0]; } catch { /* no trustworthy decoded result */ }
    }
    const actualSuccess = directTrace ? !directTrace.error : done ? true : undefined;
    const missingState: EvidenceState = ambiguous ? "Ambiguous" : "Missing evidence";
    const detail = ambiguous ? "Repeated hashes or execution indices prevent a unique association." : plan.kind === "Static" ? "Static execution cannot be established from persistent receipt logs alone." : "No uniquely associated recorded result. Reverts can roll back entry logs.";
    const checks: EvidenceCheck[] = [
      { field: "Outcome", expected: plan.entry.success === false ? "Revert" : "Success", observed: skipped ? "Skipped" : actualSuccess === undefined ? undefined : actualSuccess ? "Success" : "Revert",
        state: skipped ? "Skipped" : actualSuccess === undefined ? missingState : actualSuccess === (plan.entry.success !== false) ? "Match" : "Mismatch", detail: actualSuccess === undefined ? detail : undefined },
      { field: "Rolling hash", expected: plan.entry.rollingHash, observed: done?.args.rollingHash,
        state: done ? eq(done.args.rollingHash, plan.entry.rollingHash) ? "Match" : "Mismatch" : missingState, detail: !done ? detail : undefined },
      { field: "Return / revert data", expected: plan.entry.returnData, observed: returned,
        state: returned !== undefined ? eq(returned, plan.entry.returnData) ? "Match" : "Mismatch" : "Missing evidence", detail: returned === undefined ? "Entry completion events do not emit return bytes. A directly associated trace is needed." : undefined },
    ];
    const state: EvidenceState = checks.some(check => check.state === "Mismatch") ? "Mismatch" : skipped ? "Skipped" : ambiguous ? "Ambiguous" : checks.every(check => check.state === "Match") ? "Match" : "Missing evidence";
    return { plan, checks, state, observations };
  });
}

export type TraceFrame = { path: string; trace: CallTrace; classification?: "Unexpected failure" | "Expected revert" | "Handled revert"; explanation?: string };
export function flattenTrace(tx: DebugTransaction, trace: CallTrace): TraceFrame[] {
  const result: TraceFrame[] = [];
  const expected = executionPlans(tx).filter(plan => plan.entry.success === false && typeof plan.entry.returnData === "string");
  const visit = (node: CallTrace, path: string, handled = false) => {
    let classification: TraceFrame["classification"];
    let explanation: string | undefined;
    if (node.error) {
      const isDirectExpected = path === "0" && tx.payload?.method === "executeIncomingCrossChainCall" && expected.some(plan => plan.index === 0 && eq(plan.entry.returnData, node.output));
      classification = isDirectExpected ? "Expected revert" : handled ? "Handled revert" : "Unexpected failure";
      explanation = isDirectExpected ? "The incoming entry's trace result matches its planned revert bytes." : handled ? "A successful enclosing call handled this nested revert." : "The transaction trace failed. Inspect this frame and its children.";
    }
    result.push({ path, trace: node, classification, explanation });
    node.calls?.forEach((child, i) => visit(child, `${path}.${i}`, handled || !node.error));
  };
  visit(trace, "0");
  // Children of a directly expected root revert are part of that unwind; they
  // are not independently proven unexpected failures.
  if (result[0]?.classification === "Expected revert") for (const frame of result.slice(1)) if (frame.classification) {
    frame.classification = "Handled revert"; frame.explanation = "Nested revert inside an entry with the expected root revert result.";
  }
  return result;
}
export function firstFailurePath(tx: DebugTransaction, trace: CallTrace): string | null {
  const frames = flattenTrace(tx, trace).filter(frame => frame.classification === "Unexpected failure");
  const matching = frames.filter(frame => frame.trace.output && trace.output && eq(frame.trace.output, trace.output));
  return (matching.length ? matching[matching.length - 1] : frames[0])?.path ?? null;
}

export type BatchExecutionSummary = { state: "Inspected" | "Unavailable"; search: string; crossChain: boolean; failures: number; skipped: number; entries: number; error?: string };
export function summarizeBatch(context: DebugContext): BatchExecutionSummary {
  const txs = executionTransactions(context);
  const events = txs.flatMap(tx => tx.events.filter(event => event.protocol));
  return { state: "Inspected", search: jsonDebug(txs.map(tx => ({ hash: tx.tx.hash, from: tx.tx.from, to: tx.tx.to, calls: [...transactionHashes(tx)], entries: executionPlans(tx).map(plan => plan.entry) }))).toLowerCase(),
    crossChain: events.some(event => ["ExecutionConsumed", "CrossChainCallExecuted", "IncomingCrossChainCallExecuted"].includes(event.name)),
    failures: txs.filter(tx => tx.receipt?.status === "0x0").length, skipped: events.filter(event => event.name === "L2TxSkipped").length,
    entries: context.sourceBlock?.transactions.find(tx => txKey(tx) === (context.selected ? txKey(context.selected) : ""))?.payload?.entries.length ?? 0 };
}

export type InspectionRoute = { mode: "live" | "inspect" | "debug" | "explorer"; kind?: "transaction" | "block"; chain: string; source?: string; batch?: string | null; selected?: DebugTransaction | null; event?: number; tab?: string; call?: string | null; counterpart?: string };
export function inspectionHash(route: InspectionRoute): string {
  const params = new URLSearchParams({ mode: route.mode });
  if (route.mode === "live") { if (route.batch) params.set("batch", route.batch); }
  else { params.set("chain", route.chain); if (route.source) params.set(route.kind === "block" || route.mode === "explorer" ? "block" : "tx", route.source); }
  if (route.counterpart) params.set("counterpart", route.counterpart);
  if (route.selected) { params.set("selected", route.selected.tx.hash); params.set("selectedChain", route.selected.chain); }
  if (route.event !== undefined) params.set("event", String(route.event));
  if (route.tab) params.set("tab", route.tab);
  if (route.call) params.set("call", route.call);
  return `#/visualizer?${params}`;
}
