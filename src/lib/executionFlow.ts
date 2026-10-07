import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, keccak256, parseAbi } from 'viem';
import { config } from '../config';
import { compareExecution, txKey, type EntryPlan } from './executionAnalysis';
import { managerAddress, type CallTrace, type DebugChain, type DebugContext, type DebugTransaction } from './executionDebugger';
import { buildExecutionTimeline, type ExecutionTimeline, type TimelineStep } from './executionTimeline';

const callAbi = parseAbi(['function executeCrossChainCall(address sourceAddress, bytes callData) payable returns (bytes)', 'function executeOnBehalf(address destination, uint64 callGas, bytes data) payable']);
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const amount = (a: unknown) => { try { return BigInt(String(a ?? 0)); } catch { return -1n; } };
type Frame = { trace: CallTrace; parent?: Frame; args: readonly unknown[]; method: string; static: boolean; rolledBack: boolean };
type Incoming = { step: TimelineStep; frame: Frame; plan?: EntryPlan; call?: Record<string, unknown>; target: string; data: string };
export type FlowCall = {
  id: string; number: number; source: TimelineStep; target?: TimelineStep; caller: string; destination?: string;
  plan?: EntryPlan; targetPlan?: EntryPlan; parent?: string; basis: 'Matching call hash' | 'Replay candidate' | 'Unlinked';
  result?: { success: boolean; data: string; evidence: 'Caller trace' | 'Destination receipt' }; mismatch: boolean;
};
export type FlowAction = { id: string; call: FlowCall; kind: 'request' | 'return'; depth: number; anchor: TimelineStep };
export type FlowStateUpdate = {
  id: string; kind: 'state'; plan: EntryPlan; anchor?: TimelineStep;
  status: 'Applied' | 'Skipped' | 'Unconfirmed' | 'Mismatch';
  rollups: { rollupId: string; currentRoot: string; newRoot: string; etherDelta: string; observed?: TimelineStep }[];
};
export type FlowEntry = { id: string; plans: EntryPlan[]; calls: FlowCall[]; actions: FlowAction[]; updates: FlowStateUpdate[] };
export type ExecutionFlow = { nodes: TimelineStep[]; entries: FlowEntry[]; actions: FlowAction[]; calls: FlowCall[]; timeline: ExecutionTimeline };

// Leading zero-hash entries commit L2-origin transactions immediately on L1.
// Every one can emit entryIndex=0. Bind the completion by its unique rolling
// hash, then verify the contiguous root-update logs immediately before it.
export function flowStateUpdates(plans: EntryPlan[], timeline: ExecutionTimeline): FlowStateUpdate[] {
  return plans.filter(plan => plan.tx.chain === 'l1' && plan.tx.payload?.method === 'postAndVerifyBatch' &&
    /^0x0{64}$/i.test(String(plan.entry.proxyEntryHash)) && plan.index < (plan.tx.payload.immediateEntryCount ?? 0) &&
    plan.tx.payload.entries.slice(0, plan.index).every(entry => /^0x0{64}$/i.test(String(entry.proxyEntryHash))))
    .map(plan => {
      const steps = timeline.steps.filter(step => txKey(step.tx) === txKey(plan.tx));
      const completions = steps.filter(step => step.event.name === 'EntryExecuted' && same(step.event.args.rollingHash, plan.entry.rollingHash));
      const unique = completions.length === 1 && !plans.some(other => other.id !== plan.id && txKey(other.tx) === txKey(plan.tx) && same(other.entry.rollingHash, plan.entry.rollingHash));
      const completion = unique ? completions[0] : undefined;
      const skipped = steps.find(step => step.event.name === 'L2TxSkipped' && String(step.event.args.entryIndex) === String(plan.index));
      const expected = (plan.entry.rollupUpdates ?? []) as Record<string, unknown>[];
      const position = completion ? steps.indexOf(completion) : -1;
      const recorded = position >= expected.length ? steps.slice(position - expected.length, position) : [];
      const scoped = plan.tx.receipt?.status === '0x1' && !!completion && expected.length > 0 && recorded.length === expected.length && recorded.every((step, index) =>
        step.event.name === 'L2ExecutionPerformed' && same(step.event.raw.address, completion.event.raw.address) && String(step.event.args.rollupId) === String(expected[index]!.rollupId));
      const rollups = expected.map((update, index) => ({ rollupId: String(update.rollupId), currentRoot: String(update.currentRoot), newRoot: String(update.newRoot), etherDelta: String(update.etherDelta ?? 0), observed: scoped ? recorded[index] : undefined }));
      const status: FlowStateUpdate['status'] = skipped ? 'Skipped' : plan.tx.receipt?.status === '0x0' ? 'Unconfirmed' : scoped ?
        rollups.every(update => same(update.newRoot, update.observed!.event.args.newRoot)) ? 'Applied' : 'Mismatch' : 'Unconfirmed';
      return { id: `${plan.id}:state`, kind: 'state', plan, anchor: skipped ?? completion ?? steps.find(step => step.event.name === 'BatchPosted') ?? steps[0], status, rollups };
    });
}

export function flowEventLabel(step: TimelineStep): { title: string; detail: string } {
  const args = step.event.args;
  switch (step.event.name) {
    case 'CrossChainCallExecuted': return { title: 'Outgoing call', detail: String(args.callData ?? '0x').slice(0, 10) };
    case 'IncomingCrossChainCallExecuted': return { title: 'Incoming call', detail: String(args.data ?? '0x').slice(0, 10) };
    case 'CallResult': return { title: args.success ? 'Call returned' : 'Call reverted', detail: `#${args.callNumber ?? args.l2ToL1CallNumber ?? '?'}` };
    case 'CallsReverted': return { title: 'Calls rolled back', detail: `${args.nCalls ?? '?'} calls` };
    case 'L2TxSkipped': return { title: 'Entry skipped', detail: String(args.entryIndex ?? '?') };
    default: return { title: step.title, detail: '' };
  }
}

function traceFrames(trace: CallTrace): { before: Frame[]; after: Frame[] } {
  const before: Frame[] = [], after: Frame[] = [];
  const visit = (trace: CallTrace, parent?: Frame) => {
    let method = '', args: readonly unknown[] = [];
    try { const decoded = decodeFunctionData({ abi: callAbi, data: (trace.input ?? '0x') as `0x${string}` }); method = decoded.functionName; args = decoded.args; } catch { /* ordinary internal call */ }
    const frame: Frame = { trace, parent, method, args, static: trace.type === 'STATICCALL' || !!parent?.static, rolledBack: !!parent?.rolledBack || !!parent?.trace.error };
    before.push(frame); trace.calls?.forEach(child => visit(child, frame)); after.push(frame);
  };
  visit(trace); return { before, after };
}

function frameAncestor<T>(frame: Frame | undefined, find: (frame: Frame) => T | undefined): T | undefined {
  for (let parent = frame?.parent; parent; parent = parent.parent) { const found = find(parent); if (found !== undefined) return found; }
  return undefined;
}

export function flowTraceTransactions(context: DebugContext, selected?: DebugTransaction): DebugTransaction[] {
  const timeline = buildExecutionTimeline(context, selected);
  return [...timeline.chains.l1, ...timeline.chains.l2].filter(group => group.steps.some(step => ['CrossChainCallExecuted', 'CallResult'].includes(step.event.name))).map(group => group.tx);
}

export function buildExecutionFlow(context: DebugContext, selected?: DebugTransaction, traces: Record<string, CallTrace> = {}): ExecutionFlow {
  const timeline = buildExecutionTimeline(context, selected);
  const evidence = compareExecution(context);
  const plans = evidence.filter(item => item.plan.kind === 'Execution').map(item => item.plan);
  // Queue indices may repeat across immediate entries and nested frames. Scope
  // by uniquely associated rolling-hash completion, never by index alone.
  const scope = (step: TimelineStep): EntryPlan | undefined => {
    const completion = timeline.steps.find(node => txKey(node.tx) === txKey(step.tx) && node.eventIndex >= step.eventIndex && node.event.name === 'EntryExecuted');
    if (!completion) return undefined;
    const candidates = evidence.filter(item => item.plan.kind === 'Execution' && same(item.plan.entry.rollingHash, completion.event.args.rollingHash) &&
      (txKey(item.plan.tx) === txKey(step.tx) || item.observations.some(observation => txKey(observation.tx) === txKey(step.tx))));
    return candidates.length === 1 ? candidates[0]!.plan : undefined;
  };
  const sourceFrames = new Map<string, Frame>(), incoming: Incoming[] = [], incomingByFrame = new Map<Frame, Incoming>();
  const frameSources = new Map<Frame, string>();
  for (const group of [...timeline.chains.l1, ...timeline.chains.l2]) {
    const trace = traces[txKey(group.tx)]; if (!trace) continue;
    const managers = new Set([managerAddress(group.tx.chain).toLowerCase(), ...group.steps.map(step => step.event.raw.address.toLowerCase())]);
    const frames = traceFrames(trace);
    const outgoing = group.steps.filter(step => step.event.name === 'CrossChainCallExecuted');
    const candidates = frames.before.filter(frame => frame.trace.type === 'CALL' && !frame.static && !frame.rolledBack && !frame.trace.error && frame.method === 'executeCrossChainCall' && managers.has(frame.trace.to?.toLowerCase() ?? ''));
    const matches = (frame: Frame, step: TimelineStep) => same(frame.trace.from, step.event.args.proxy) && same(frame.args[0], step.event.args.sourceAddress) && same(frame.args[1], step.event.args.callData) && amount(frame.trace.value) === amount(step.event.args.value);
    // Surviving log order and trace preorder identify repeated invocations on
    // one chain; never use this ordering to pair repeats across chains.
    for (const step of outgoing) {
      const logs = outgoing.filter(other => same(other.event.args.proxy, step.event.args.proxy) && same(other.event.args.sourceAddress, step.event.args.sourceAddress) && same(other.event.args.callData, step.event.args.callData) && amount(other.event.args.value) === amount(step.event.args.value));
      const matching = candidates.filter(frame => matches(frame, step));
      const frame = logs.length === matching.length ? matching[logs.indexOf(step)] : undefined;
      if (frame) { sourceFrames.set(step.id, frame); frameSources.set(frame, step.id); }
    }
    const results = group.steps.filter(step => step.event.name === 'CallResult');
    const dispatches = frames.after.filter(frame => ['CALL', 'STATICCALL'].includes(frame.trace.type) && !frame.parent?.static && !frame.rolledBack && frame.method === 'executeOnBehalf' && managers.has(frame.trace.from.toLowerCase()));
    // CallResult is emitted after dispatch returns. Postorder keeps nested
    // ordinal-zero results distinct from the enclosing ordinal-zero result.
    if (results.length !== dispatches.length || dispatches.some((frame, index) => !same(frame.trace.output ?? '0x', results[index]!.event.args.returnData ?? '0x') || !frame.trace.error !== (results[index]!.event.args.success === true))) continue;
    dispatches.forEach((frame, index) => {
      const step = results[index]!, plan = scope(step);
      const lists = plan ? [plan.entry, ...((plan.entry.expectedL1ToL2Calls ?? plan.entry.expectedOutgoingCalls ?? []) as Record<string, unknown>[])] : [];
      const ordinal = Number(step.event.args.callNumber ?? step.event.args.l2ToL1CallNumber);
      // Each nested frame has its own local ordinals. Consider that position in
      // every possible frame, then validate the actual dispatch parameters.
      // Earlier identical calls may have executed in a rolled-back context.
      const calls = lists.flatMap(entry => {
        const call = ((entry.l2ToL1Calls ?? entry.incomingCalls ?? []) as Record<string, unknown>[])[ordinal];
        return call ? [call] : [];
      });
      const candidates = calls.filter(call => call.isStatic !== true && same(call.targetAddress, frame.args[0]) && same(call.data, frame.args[2]) && amount(call.gas) === amount(frame.args[1]) && amount(call.value) === amount(frame.trace.value) &&
        (call.sourceRollupId === undefined || String(call.sourceRollupId) === (group.tx.chain === 'l2' ? '0' : String(config.rollupId))));
      const record: Incoming = { step, frame, plan, call: candidates.length === 1 ? candidates[0] : undefined, target: String(frame.args[0]), data: String(frame.args[2]) };
      incoming.push(record); incomingByFrame.set(frame, record);
    });
  }
  const outgoing = timeline.steps.filter(step => step.event.name === 'CrossChainCallExecuted');
  const candidates = outgoing.map(source => {
    const records = incoming.filter(record => record.step.tx.chain !== source.tx.chain && record.call && same(record.call.sourceAddress, source.event.args.sourceAddress) && same(record.data, source.event.args.callData) && amount(record.call.value) === amount(source.event.args.value));
    const identities = records.map(record => {
      try {
        return { record, hash: keccak256(encodeAbiParameters(
          [{ type: 'bool' }, { type: 'address' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'bytes' }],
          [false, String(record.call!.sourceAddress) as `0x${string}`, amount(record.call!.sourceRollupId), record.target as `0x${string}`,
            record.step.tx.chain === 'l1' ? 0n : amount(config.rollupId), amount(record.call!.value), amount(source.event.args.callGas), record.data as `0x${string}`]
        )) };
      } catch { return { record, hash: null }; }
    });
    const hashMatches = identities.filter(identity => same(source.event.args.crossChainCallHash, identity.hash)).map(identity => identity.record);
    const matching = identities.some(identity => identity.hash) && source.hash ? hashMatches : records;
    const frame = sourceFrames.get(source.id);
    let result: FlowCall['result'];
    if (frame?.trace.output) {
      try { result = { success: !frame.trace.error, data: decodeAbiParameters([{ type: 'bytes' }], frame.trace.output as `0x${string}`)[0], evidence: 'Caller trace' }; } catch { /* malformed output is not return evidence */ }
    }
    return { source, hashMatches, matching, result };
  });
  // Return bytes distinguish repeated invocations only after their identities
  // and entry-scoped dispatches have matched. Keep a uniquely identified
  // disagreement visible instead of filtering away a genuine mismatch.
  const owners = new Map<Incoming, number>();
  for (const candidate of candidates) for (const record of candidate.matching) owners.set(record, (owners.get(record) ?? 0) + 1);
  for (const candidate of candidates) if (candidate.result && (candidate.matching.length > 1 || candidate.matching.some(record => owners.get(record)! > 1))) {
    candidate.matching = candidate.matching.filter(record => candidate.result!.success === (record.step.event.args.success === true) && same(candidate.result!.data, record.step.event.args.returnData ?? '0x'));
  }
  const uniqueMatches = () => {
    const counts = new Map<Incoming, number>();
    for (const candidate of candidates) for (const record of candidate.matching) counts.set(record, (counts.get(record) ?? 0) + 1);
    return new Map(candidates.flatMap(candidate => candidate.matching.length === 1 && counts.get(candidate.matching[0]!) === 1 ? [[candidate.source.id, candidate.matching[0]!] as const] : []));
  };
  // A linked callback locates its enclosing request on BOTH chains: its source
  // is inside the remote dispatch, and its destination is inside the original
  // caller's frame. Propagate that context in both directions, never pairing
  // repeated calls by global occurrence order or a resettable queue index.
  let changed = true;
  while (changed) {
    changed = false;
    const linked = uniqueMatches(), reverse = new Map([...linked].map(([id, record]) => [record, id]));
    const parentAnchors = new Map<string, Set<Incoming>>();
    for (const [id, record] of linked) {
      const remoteParent = frameAncestor(sourceFrames.get(id), frame => incomingByFrame.get(frame));
      const localParent = frameAncestor(record.frame, frame => frameSources.get(frame));
      if (remoteParent && localParent) {
        if (!parentAnchors.has(localParent)) parentAnchors.set(localParent, new Set());
        parentAnchors.get(localParent)!.add(remoteParent);
      }
    }
    for (const candidate of candidates) {
      const sourceParent = frameAncestor(sourceFrames.get(candidate.source.id), frame => incomingByFrame.get(frame));
      const boundParent = sourceParent ? reverse.get(sourceParent) : undefined;
      const anchors = parentAnchors.get(candidate.source.id);
      const next = candidate.matching.filter(record => {
        if (anchors && (anchors.size !== 1 || !anchors.has(record))) return false;
        const targetParent = frameAncestor(record.frame, frame => frameSources.get(frame));
        if (boundParent && targetParent && boundParent !== targetParent) return false;
        const boundDispatch = targetParent ? linked.get(targetParent) : undefined;
        return !sourceParent || !boundDispatch || boundDispatch === sourceParent;
      });
      if (next.length !== candidate.matching.length) { candidate.matching = next; changed = true; }
    }
  }
  const linked = uniqueMatches();
  const calls: FlowCall[] = candidates.map(({ source, hashMatches, result: callerResult }, index) => {
    const record = linked.get(source.id), verified = !!record && hashMatches.includes(record);
    const exact = timeline.connections.filter(connection => connection.from === source.id && connection.basis === 'Matching call hash' && !connection.ambiguous).map(connection => timeline.steps.find(step => step.id === connection.to)).filter((step): step is TimelineStep => step?.event.name === 'IncomingCrossChainCallExecuted');
    const target = record?.step ?? (exact.length === 1 ? exact[0] : undefined);
    const result = callerResult ?? (record ? { success: record.step.event.args.success === true, data: String(record.step.event.args.returnData ?? '0x'), evidence: 'Destination receipt' as const } : undefined);
    return { id: source.id, number: index + 1, source, target, caller: String(source.event.args.sourceAddress ?? '?'), destination: record?.target ?? (target?.event.name === 'IncomingCrossChainCallExecuted' ? String(target.event.args.destination) : undefined), plan: scope(source), targetPlan: record?.plan ?? (target ? scope(target) : undefined), basis: record ? verified ? 'Matching call hash' : 'Replay candidate' : target ? 'Matching call hash' : 'Unlinked', result,
      mismatch: !!record && !!result && (result.success !== (record.step.event.args.success === true) || !same(result.data, record.step.event.args.returnData ?? '0x')) };
  });
  const bySource = new Map(calls.map(call => [call.id, call]));
  const byIncoming = new Map(incoming.flatMap(record => { const call = calls.find(call => call.target?.id === record.step.id); return call ? [[record, call] as const] : []; }));
  for (const call of calls) {
    const sourceParent = frameAncestor(sourceFrames.get(call.id), frame => { const record = incomingByFrame.get(frame); return record ? byIncoming.get(record) : undefined; });
    const record = incoming.find(record => record.step.id === call.target?.id);
    const targetParent = frameAncestor(record?.frame, frame => bySource.get(frameSources.get(frame) ?? ''));
    if (sourceParent && targetParent && sourceParent.id !== targetParent.id) continue;
    const parent = sourceParent ?? targetParent;
    if (parent && parent.id !== call.id) call.parent = parent.id;
  }
  // Reject cycles instead of inventing an execution order from contradictory
  // or incomplete evidence.
  for (const call of calls) { const seen = new Set([call.id]); let parent = call.parent; while (parent) { if (seen.has(parent)) { call.parent = undefined; break; } seen.add(parent); parent = bySource.get(parent)?.parent; } }
  const roots = new Map<string, string>();
  const root = (id: string): string => { const parent = roots.get(id); return parent && parent !== id ? root(parent) : id; };
  const join = (a: string, b: string) => { roots.set(root(b), root(a)); };
  for (const plan of plans) roots.set(plan.id, plan.id);
  for (const call of calls) {
    roots.set(call.id, call.id);
    if (call.plan) join(call.id, call.plan.id);
    if (call.targetPlan) join(call.id, call.targetPlan.id);
  }
  for (const call of calls) if (call.parent) join(call.id, call.parent);
  const entries = new Map<string, FlowEntry>();
  const entry = (id: string) => { const key = root(id); if (!entries.has(key)) entries.set(key, { id: key, plans: [], calls: [], actions: [], updates: [] }); return entries.get(key)!; };
  for (const plan of plans) entry(plan.id).plans.push(plan);
  for (const update of flowStateUpdates(plans, timeline)) entry(update.plan.id).updates.push(update);
  for (const call of calls) entry(call.id).calls.push(call);
  for (const group of entries.values()) {
    const visit = (call: FlowCall, depth: number) => {
      group.actions.push({ id: `${call.id}:request`, call, kind: 'request', depth, anchor: call.source });
      group.calls.filter(child => child.parent === call.id).forEach(child => visit(child, depth + 1));
      group.actions.push({ id: `${call.id}:return`, call, kind: 'return', depth, anchor: call.target?.event.name === 'CallResult' ? call.target : call.source });
    };
    group.calls.filter(call => !call.parent).forEach(call => visit(call, 0));
  }
  let number = 0;
  for (const group of entries.values()) for (const action of group.actions) if (action.kind === 'request') action.call.number = ++number;
  const nodes = timeline.steps.filter(step => ['Call', 'Result', 'Rollback'].includes(step.kind));
  return { nodes, entries: [...entries.values()], actions: [...entries.values()].flatMap(entry => entry.actions), calls, timeline };
}

export const otherChain = (chain: DebugChain): DebugChain => chain === 'l1' ? 'l2' : 'l1';

// A cached source result establishes only the source-side return. It cannot
// place an unobserved destination on the remote lane.
export function flowReturnKind(call: FlowCall): 'cross-chain' | 'local' | 'unavailable' {
  return call.target && call.destination && call.result ? 'cross-chain' : call.result?.evidence === 'Caller trace' ? 'local' : 'unavailable';
}

export type FlowExecutionConnection = { id: string; chain: DebugChain; call: FlowCall; from: FlowAction; to: FlowAction };

// Follow execution on the receiving chain, including the points where it
// initiates a nested call and resumes after that call returns. The sender is
// waiting between request and return, not executing the remote call.
export function flowExecutionConnections(entry: FlowEntry): FlowExecutionConnection[] {
  const connections: FlowExecutionConnection[] = [];
  const request = (call: FlowCall) => entry.actions.find(action => action.call.id === call.id && action.kind === 'request');
  const returned = (call: FlowCall) => entry.actions.find(action => action.call.id === call.id && action.kind === 'return');
  const add = (call: FlowCall, chain: DebugChain, from?: FlowAction, to?: FlowAction) => {
    if (from && to) connections.push({ id: `${chain}:${from.id}:${to.id}`, chain, call, from, to });
  };
  for (const call of entry.calls) {
    if (flowReturnKind(call) !== 'cross-chain') continue;
    const chain = otherChain(call.source.tx.chain);
    let previous = request(call);
    for (const child of entry.calls.filter(child => child.parent === call.id)) {
      if (child.source.tx.chain !== chain) { previous = undefined; continue; }
      add(call, chain, previous, request(child));
      previous = child.result ? returned(child) : undefined;
    }
    add(call, chain, previous, returned(call));
  }
  const roots = entry.actions.filter(action => action.kind === 'request' && !action.call.parent).map(action => action.call);
  for (let i = 1; i < roots.length; i++) {
    const before = roots[i - 1]!, after = roots[i]!;
    // Adjacent calls by this same contract in the same transaction have a
    // recorded local continuation. Sharing an entry or block is insufficient.
    if (before.result?.evidence === 'Caller trace' && txKey(before.source.tx) === txKey(after.source.tx) && same(before.caller, after.caller)) {
      add(before, before.source.tx.chain, returned(before), request(after));
    }
  }
  return connections;
}
