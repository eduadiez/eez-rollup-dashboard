import { config } from '../config';
import { buildExecutionPairs, compareExecution, eventCallHash, isEezTransaction, txKey } from './executionAnalysis';
import { jsonDebug, quantity, type DebugChain, type DebugContext, type DebugEvent, type DebugTransaction } from './executionDebugger';

export type TimelineStep = { id: string; tx: DebugTransaction; event: DebugEvent; eventIndex: number; order: number; hash: string | null; title: string; description: string; kind: 'Call' | 'Entry' | 'Result' | 'Rollback' | 'Settlement' | 'Table' | 'Event' };
export type TimelineTransaction = { tx: DebugTransaction; timestamp: string | null; steps: TimelineStep[] };
export type TimelineConnection = { from: string; to: string; basis: 'Matching call hash' | 'Replay candidate'; hash: string | null; ambiguous: boolean };
export type ExecutionTimeline = { chains: Record<DebugChain, TimelineTransaction[]>; connections: TimelineConnection[]; steps: TimelineStep[] };
export type TimelineRow = { id: string; l1: TimelineStep | null; l2: TimelineStep | null; connection: TimelineConnection | null };
const entryIndex = (event: DebugEvent) => String(event.args.entryQueueIndex ?? event.args.entryIndex ?? '');
const validAddress = (value: unknown) => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const hex = (value: unknown) => typeof value === 'string' && /^0x[\da-f]*$/i.test(value) ? value.toLowerCase() : null;
const preview = (value: unknown) => { const text = String(value ?? ''); return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text; };

export function describeTimelineEvent(chain: DebugChain, event: DebugEvent): Pick<TimelineStep, 'title' | 'description' | 'kind'> {
  const args = event.args;
  switch (event.name) {
    case 'ExecutionTableLoaded': return { title: 'Execution table loaded', description: `${(args.entries as unknown[])?.length ?? 0} execution entries · ${(args.staticEntries as unknown[])?.length ?? 0} static entries. These are the execution plan.`, kind: 'Table' };
    case 'ExecutionConsumed': return { title: `${chain === 'l1' ? 'Queue entry' : 'Entry'} ${entryIndex(event)} consumed`, description: 'The protocol selected this entry for execution.', kind: 'Entry' };
    case 'EntryExecuted': return { title: `Entry ${entryIndex(event)} completed`, description: `Rolling hash recorded${args.callsProcessed !== undefined ? ` · ${args.callsProcessed} calls processed` : ''}.`, kind: 'Entry' };
    case 'CrossChainCallExecuted': return { title: 'Outgoing cross-chain call recorded', description: `${preview(args.sourceAddress)} → proxy ${preview(args.proxy)} · selector ${String(args.callData ?? '0x').slice(0, 10)}`, kind: 'Call' };
    case 'IncomingCrossChainCallExecuted': return { title: 'Incoming cross-chain call recorded', description: `${preview(args.sourceAddress)} → ${preview(args.destination)} · selector ${String(args.data ?? '0x').slice(0, 10)}`, kind: 'Call' };
    case 'CallResult': return { title: `Call ${args.l2ToL1CallNumber ?? args.callNumber} ${args.success ? 'returned' : 'reverted'}`, description: `Entry ${entryIndex(event)} · ${args.success ? 'successful call result' : 'revert result recorded; this may be expected'} · ${Math.max(0, (String(args.returnData ?? '0x').length - 2) / 2)} result bytes`, kind: 'Result' };
    case 'CallsReverted': {
      const start = BigInt(String(args.startL2ToL1Call ?? args.startCallNumber ?? 0));
      const count = BigInt(String(args.nCalls ?? 0));
      return { title: `Calls ${start}${count > 1n ? `–${start + count - 1n}` : ''} rolled back`, description: `Entry ${entryIndex(event)} · ${count} calls executed in a reverted context; their state changes were rolled back.`, kind: 'Rollback' };
    }
    case 'L2TxSkipped': return { title: `Entry ${entryIndex(event)} skipped`, description: 'The batch recorded a skipped execution. Inspect the revert data for its reason.', kind: 'Rollback' };
    case 'L2ExecutionPerformed': return { title: `Rollup ${args.rollupId} commitment updated`, description: `Root ${preview(args.newRoot)} recorded on ${chain.toUpperCase()}.`, kind: 'Settlement' };
    case 'BatchPosted': return { title: 'Batch verified and posted', description: args.rollupIds ? `Rollups ${String(args.rollupIds)} · settlement recorded on L1.` : 'Settlement recorded on L1.', kind: 'Settlement' };
    default: return { title: event.name, description: 'Recorded protocol event.', kind: 'Event' };
  }
}

export function buildExecutionTimeline(context: DebugContext, selected?: DebugTransaction): ExecutionTimeline {
  // Use the same selected-batch scope as evidence comparison. A separately
  // selected EEZ transaction remains inspectable without including ordinary txs.
  const evidence = compareExecution(context);
  const evidenceScope = new Set(evidence.map(item => txKey(item.plan.tx)));
  const pairs = buildExecutionPairs(context);
  for (const pair of pairs) for (const occurrence of pair.occurrences) evidenceScope.add(txKey(occurrence.tx));
  if (context.selected) evidenceScope.add(txKey(context.selected));
  if (selected) evidenceScope.add(txKey(selected));
  const batchScope = context.selected?.chain === 'l1' && context.selected.payload?.method === 'postAndVerifyBatch';
  const chains: ExecutionTimeline['chains'] = { l1: [], l2: [] };
  const transactions = context.blocks.flatMap(block => block.transactions.map(tx => ({ tx, timestamp: block.timestamp, number: block.number }))).sort((a, b) => {
    if (a.tx.chain !== b.tx.chain) return a.tx.chain === 'l1' ? -1 : 1;
    const block = BigInt(a.number) - BigInt(b.number);
    return block ? block > 0n ? 1 : -1 : Number(BigInt(a.tx.tx.transactionIndex ?? 0) - BigInt(b.tx.tx.transactionIndex ?? 0));
  });
  const seen = new Set<string>();
  const order: Record<DebugChain, number> = { l1: 0, l2: 0 };
  const add = (tx: DebugTransaction, timestamp: string | null) => {
    if (!isEezTransaction(tx) || seen.has(txKey(tx)) || batchScope && tx.chain === 'l1' && !evidenceScope.has(txKey(tx))) return;
    seen.add(txKey(tx));
    const events = tx.events.filter(event => event.protocol).map((event, eventIndex) => ({ event, eventIndex }));
    events.sort((a, b) => Number(BigInt(a.event.raw.logIndex) - BigInt(b.event.raw.logIndex)));
    chains[tx.chain].push({ tx, timestamp, steps: events.map(({ event, eventIndex }) => ({
      id: `${txKey(tx)}:${eventIndex}`, tx, event, eventIndex, order: ++order[tx.chain], hash: eventCallHash(tx, eventIndex), ...describeTimelineEvent(tx.chain, event),
    })) });
  };
  for (const transaction of transactions) add(transaction.tx, transaction.timestamp);
  if (selected) add(selected, null);
  else if (context.selected) add(context.selected, null);
  const steps = [...chains.l1, ...chains.l2].flatMap(transaction => transaction.steps);
  const connections: TimelineConnection[] = [];
  const ids = new Set(steps.map(step => step.id));
  const addConnection = (connection: TimelineConnection) => {
    if (ids.has(connection.from) && ids.has(connection.to) && !connections.some(item => item.from === connection.from && item.to === connection.to)) connections.push(connection);
  };
  for (const pair of pairs) {
    const outgoing = pair.occurrences.filter(item => item.role === 'Outgoing');
    for (const source of outgoing) for (const target of pair.occurrences.filter(item => item.tx.chain !== source.tx.chain && item.role !== 'Outgoing')) {
      addConnection({ from: source.id, to: target.id, basis: 'Matching call hash', hash: pair.hash, ambiguous: pair.ambiguous || outgoing.filter(item => item.tx.chain === source.tx.chain).length > 1 });
    }
  }
  // A replayed incoming call can have a different entry-trigger hash. Link
  // candidates through a uniquely associated table and call ordinal, without
  // claiming that source/data/value alone prove destination or global timing.
  const replaySources = (call: Record<string, unknown>, chain: DebugChain) => {
    if (call.isStatic === true || !validAddress(call.sourceAddress) || !hex(call.data)) return [];
    return steps.filter(step => step.tx.chain !== chain && step.event.name === 'CrossChainCallExecuted' &&
      validAddress(step.event.args.sourceAddress) === validAddress(call.sourceAddress) && hex(step.event.args.callData) === hex(call.data) &&
      String(step.event.args.value ?? 0) === String(call.value ?? 0) &&
      (call.sourceRollupId === undefined || (chain === 'l2' ? String(call.sourceRollupId) === '0' : String(call.sourceRollupId) === String(config.rollupId))));
  };
  for (const entry of evidence) {
    if (entry.plan.kind !== 'Execution' || entry.state === 'Ambiguous') continue;
    const incoming = (entry.plan.entry.incomingCalls ?? entry.plan.entry.l2ToL1Calls ?? []) as Record<string, unknown>[];
    for (const occurrence of entry.observations) {
      const boundary = steps.find(step => txKey(step.tx) === txKey(occurrence.tx) && step.eventIndex > occurrence.eventIndex && ['ExecutionConsumed', 'EntryExecuted'].includes(step.event.name) && entryIndex(step.event) === occurrence.entryIndex);
      const resultSteps = steps.filter(step => (!boundary || step.eventIndex < boundary.eventIndex) && txKey(step.tx) === txKey(occurrence.tx) && step.eventIndex > occurrence.eventIndex && step.event.name === 'CallResult' && entryIndex(step.event) === occurrence.entryIndex);
      for (const result of resultSteps) {
        const ordinal = Number(result.event.args.callNumber ?? result.event.args.l2ToL1CallNumber);
        const call = incoming[ordinal];
        if (!call) continue;
        const sources = replaySources(call, result.tx.chain);
        const repeatedResults = resultSteps.filter(step => Number(step.event.args.callNumber ?? step.event.args.l2ToL1CallNumber) === ordinal).length > 1;
        for (const source of sources) addConnection({ from: source.id, to: result.id, basis: 'Replay candidate', hash: null, ambiguous: sources.length > 1 || repeatedResults });
      }
    }
    // Immediate L1 entries have no consumed hash and their queue indices can
    // repeat through reentry. A unique rolling-hash completion links the entry,
    // without guessing which nested CallResult belongs to it.
    if (!entry.plan.hash && entry.checks.some(check => check.field === 'Rolling hash' && check.state === 'Match')) {
      const completions = steps.filter(step => txKey(step.tx) === txKey(entry.plan.tx) && step.event.name === 'EntryExecuted' && hex(step.event.args.rollingHash) === hex(entry.plan.entry.rollingHash));
      if (completions.length === 1) for (const call of incoming) {
        const sources = replaySources(call, entry.plan.tx.chain);
        for (const source of sources) addConnection({ from: source.id, to: completions[0]!.id, basis: 'Replay candidate', hash: null, ambiguous: sources.length > 1 });
      }
    }
  }
  // Multiple candidate destinations for one source are also ambiguous.
  for (const connection of connections) {
    if (connections.filter(item => item.from === connection.from && item.basis === connection.basis && item.to !== connection.to).some(item => steps.find(step => step.id === item.to)?.event.name === steps.find(step => step.id === connection.to)?.event.name)) connection.ambiguous = true;
  }
  return { chains, connections, steps };
}

// A shared row represents linked evidence, never merely two similar block
// timestamps. Choose noncrossing anchors so nested completions cannot reverse
// either chain's recorded order. Unresolved links remain navigable across rows.
export function alignTimelineRows(timeline: ExecutionTimeline): TimelineRow[] {
  const l1 = timeline.chains.l1.flatMap(transaction => transaction.steps);
  const l2 = timeline.chains.l2.flatMap(transaction => transaction.steps);
  const positions = new Map<string, { chain: DebugChain; index: number }>([...l1.map((step, index) => [step.id, { chain: 'l1', index }] as const), ...l2.map((step, index) => [step.id, { chain: 'l2', index }] as const)]);
  const anchors = timeline.connections.flatMap(connection => {
    const from = positions.get(connection.from), to = positions.get(connection.to);
    if (connection.ambiguous || !from || !to || from.chain === to.chain) return [];
    return [{ connection, a: from.chain === 'l1' ? from.index : to.index, b: from.chain === 'l2' ? from.index : to.index }];
  }).sort((a, b) => a.a - b.a || a.b - b.b);
  // Weighted increasing subsequence, with a prefix tree rather than a dense
  // events-by-events matrix. Exact hashes outrank replay candidates; an actual
  // incoming event outranks entry consumption for the same outgoing call.
  const base = anchors.length + 1;
  const scores = anchors.map(() => 0), previous = anchors.map(() => -1);
  const tree = Array<number>(l2.length + 1).fill(-1);
  const better = (a: number, b: number) => a >= 0 && (b < 0 || scores[a]! > scores[b]!) ? a : b;
  const query = (end: number) => { let best = -1; for (let i = end; i > 0; i -= i & -i) best = better(tree[i]!, best); return best; };
  const update = (position: number, candidate: number) => { for (let i = position + 1; i < tree.length; i += i & -i) tree[i] = better(candidate, tree[i]!); };
  for (let start = 0; start < anchors.length;) {
    let end = start + 1;
    while (end < anchors.length && anchors[end]!.a === anchors[start]!.a) end++;
    for (let i = start; i < end; i++) {
      const anchor = anchors[i]!;
      const incoming = [l1[anchor.a], l2[anchor.b]].some(step => step?.event.name === 'IncomingCrossChainCallExecuted');
      previous[i] = query(anchor.b);
      scores[i] = (previous[i]! < 0 ? 0 : scores[previous[i]!]!) + (anchor.connection.basis === 'Matching call hash' ? base * base + (incoming ? base : 0) : 1);
    }
    // Delayed updates prevent two destinations pairing with the same L1 event.
    for (let i = start; i < end; i++) update(anchors[i]!.b, i);
    start = end;
  }
  const chosen: typeof anchors = [];
  for (let i = query(l2.length); i >= 0; i = previous[i]!) chosen.push(anchors[i]!);
  chosen.reverse();
  const rows: TimelineRow[] = [];
  let a = 0, b = 0;
  const add = (left: TimelineStep | null, right: TimelineStep | null, connection: TimelineConnection | null = null) => rows.push({ id: `${left?.id ?? '-'}|${right?.id ?? '-'}`, l1: left, l2: right, connection });
  const unpaired = (endA: number, endB: number) => {
    // Interleave independent gaps without pretending their events are paired.
    while (a < endA || b < endB) {
      if (a < endA) add(l1[a++]!, null);
      if (b < endB) add(null, l2[b++]!);
    }
  };
  for (const anchor of chosen) {
    unpaired(anchor.a, anchor.b);
    add(l1[a++]!, l2[b++]!, anchor.connection);
  }
  unpaired(l1.length, l2.length);
  return rows;
}

export function timelineTransactionTitle(tx: DebugTransaction): string {
  if (tx.payload?.method === 'postAndVerifyBatch') return 'Verify and post batch';
  if (tx.payload?.method === 'loadExecutionTable') return 'Load L2 execution table';
  if (tx.payload?.method === 'executeIncomingCrossChainCall') return 'Execute incoming cross-chain call';
  return tx.payload?.method ?? 'EEZ contract execution';
}

export function timelineClock(timestamp: string | null): string {
  if (!timestamp) return 'Block time unavailable';
  return new Date(Number(BigInt(timestamp)) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const timelinePosition = (step: TimelineStep) => `${step.tx.chain.toUpperCase()} event ${step.order} · block #${quantity(step.tx.tx.blockNumber)} · tx ${quantity(step.tx.tx.transactionIndex)} · log ${quantity(step.event.raw.logIndex)}`;
export const timelineEventJson = (step: TimelineStep) => jsonDebug(step.event.args);
