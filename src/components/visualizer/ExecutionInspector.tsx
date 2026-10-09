import { useEffect, useMemo, useRef, useState } from "react";
import { decodeRevert, jsonDebug, quantity, type CallTrace, type DebugChain, type DebugContext, type DebugPayload, type DebugTransaction } from "../../lib/executionDebugger";
import { compareExecution, firstFailurePath, flattenTrace, txKey, type TraceFrame } from "../../lib/executionAnalysis";
import { decodeTraceCall, getExecutionAbi, type ContractAbi } from "../../lib/executionAbi";
import { ExplorerLink } from "../ExplorerLink";
import { ExecutionFlow } from "./ExecutionFlow";
import { ExecutionTimeline } from "./ExecutionTimeline";
import styles from "./ExecutionDebugger.module.css";
const short = (value: string) => value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
export type InspectorTab = "flow" | "timeline" | "calls" | "entries" | "raw";
export const inspectorTab = (value: string | null | undefined): InspectorTab => value === "timeline" || value === "calls" || value === "entries" || value === "raw" ? value : "flow";
function RawData({ value, label = "Raw data", open = false }: { value: unknown; label?: string; open?: boolean }) {
  return <details className={styles.raw} open={open}><summary>{label}</summary><pre>{jsonDebug(value)}</pre></details>;
}

function Payload({ payload, chain }: { payload: DebugPayload; chain: DebugChain }) {
  return <section className={styles.section}>
    <h3>{payload.method}</h3>
    <p className={styles.muted}>{payload.entries.length} execution {payload.entries.length === 1 ? "entry" : "entries"} · {payload.staticEntries.length} static {payload.staticEntries.length === 1 ? "entry" : "entries"}
      {payload.method === "postAndVerifyBatch" && ` · ${payload.immediateEntryCount} immediate execution ${payload.immediateEntryCount === 1 ? "entry" : "entries"}`}</p>
    {[...payload.entries.map((entry, i) => ({ entry, i, kind: "Execution" })), ...payload.staticEntries.map((entry, i) => ({ entry, i, kind: "Static" }))].map(({ entry, i, kind }) => {
      const calls = (entry.l2ToL1Calls ?? entry.incomingCalls ?? []) as Record<string, unknown>[];
      const nested = (entry.expectedL1ToL2Calls ?? entry.expectedOutgoingCalls ?? []) as Record<string, unknown>[];
      return <details key={`${kind}-${i}`} className={styles.entry}>
        <summary><strong>{kind} entry {i}</strong> <span>{entry.success === false ? "Expected revert" : "Expected success"}</span>
          <code>{short(String(entry.proxyEntryHash))}</code> <span>{calls.length} calls · {nested.length} reentrant frames</span></summary>
        <dl className={styles.fields}>
          <dt>Proxy entry hash</dt><dd><code>{String(entry.proxyEntryHash)}</code></dd>
          <dt>Expected rolling hash</dt><dd><code>{String(entry.rollingHash)}</code></dd>
          {entry.destinationRollupId != null && <><dt>Destination rollup</dt><dd>{String(entry.destinationRollupId)}</dd></>}
          <dt>Return / revert data</dt><dd><code>{String(entry.returnData)}</code>{entry.success === false && <p>{decodeRevert(chain, String(entry.returnData))}</p>}</dd>
        </dl>
        {calls.map((call, index) => <div className={styles.plannedCall} key={index}>
          <span>{index + 1}. {call.isStatic ? "STATICCALL" : "CALL"}</span><ExplorerLink value={String(call.targetAddress)} chain={chain} short={false} />
          <span>{quantity(call.gas as bigint)} gas · {quantity(call.value as bigint)} wei</span>
          {Number(call.revertNextNCalls) > 0 && <span className={styles.failed}>Rollback span: {String(call.revertNextNCalls)} calls</span>}
          <RawData value={call} label="Call parameters" />
        </div>)}
        {nested.length > 0 && <RawData value={nested} label="Reentrant frames and expected results" />}
        {(entry.rollupUpdates ?? entry.expectedRoots) != null && <RawData value={entry.rollupUpdates ?? entry.expectedRoots} label="Rollup commitments and ether changes" />}
        <RawData value={entry} label="Complete entry" />
      </details>;
    })}
    <RawData value={payload.args} label="Complete decoded calldata" />
  </section>;
}

function TraceNode({ trace, chain, path, frames, focus }: { trace: CallTrace; chain: DebugChain; path: string; frames: TraceFrame[]; focus: string | null }) {
  const [contract, setContract] = useState<ContractAbi | null>(null);
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => { let stopped = false; if (trace.to) void getExecutionAbi(chain, trace.to).then(value => { if (!stopped) setContract(value); }); return () => { stopped = true; }; }, [chain, trace.to]);
  useEffect(() => { if (focus && (focus === path || focus.startsWith(`${path}.`)) && element.current) element.current.open = true; }, [focus, path]);
  const decoded = decodeTraceCall(chain, trace, contract);
  const frame = frames.find(item => item.path === path);
  return <details ref={element} data-trace-path={path} className={`${styles.traceNode} ${frame?.classification === 'Unexpected failure' ? styles.traceFailed : ''} ${focus === path ? styles.activeStep : ''}`} open={path.split('.').length < 3}>
    <summary><span className={styles.callType}>{trace.type}</span><strong>{decoded.name || (trace.to ? short(trace.to) : 'CREATE')}</strong>
      <span>{decoded.method ?? trace.input?.slice(0, 10) ?? ''}</span>{trace.gasUsed && <span>{quantity(trace.gasUsed)} gas</span>}
      {frame?.classification && <span className={styles.evidenceBadge} data-state={frame.classification === 'Unexpected failure' ? 'Mismatch' : 'Expected'}>{frame.classification}</span>}</summary>
    <div className={styles.traceBody}>
      <dl className={styles.fields}><dt>From</dt><dd><ExplorerLink value={trace.from} chain={chain} /></dd>{trace.to && <><dt>To</dt><dd><ExplorerLink value={trace.to} chain={chain} /></dd></>}
        <dt>Value</dt><dd>{quantity(trace.value ?? '0x0')} wei</dd>
        {frame?.classification && <><dt>{frame.classification}</dt><dd>{decoded.error ?? trace.revertReason ?? decodeRevert(chain, trace.output) ?? trace.error}<p className={styles.muted}>{frame.explanation}</p></dd></>}
      </dl>
      {decoded.args !== undefined && <RawData value={decoded.args} label="Decoded arguments" />}
      {decoded.result !== undefined && <RawData value={decoded.result} label="Decoded return value" />}
      <RawData value={{ input: trace.input ?? '0x', output: trace.output ?? '0x' }} label="Raw calldata and result" />
      {trace.calls?.map((child, i) => <TraceNode key={i} trace={child} chain={chain} path={`${path}.${i}`} frames={frames} focus={focus} />)}
    </div>
  </details>;
}

export function ExecutionInspector({ tx, context, traces, loadTrace, tab, onTab, step, focused, flowDetailAction, onFlowDetailAction, onFocus, onSelect }: {
  tx: DebugTransaction; context: DebugContext; traces: Record<string, CallTrace>; loadTrace: (tx: DebugTransaction) => Promise<CallTrace>;
  tab: InspectorTab; onTab: (tab: InspectorTab) => void; step: number;
  flowDetailAction: string | null; onFlowDetailAction: (action: string | null) => void;
  focused: string | null; onFocus: (hash: string | null) => void; onSelect: (tx: DebugTransaction, event?: number, hash?: string) => void;
}) {
  const trace = traces[txKey(tx)];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceFocus, setTraceFocus] = useState<string | null>(null);
  const [entryFocus, setEntryFocus] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const events = tx.events.filter(event => event.protocol);
  const frames = useMemo(() => trace ? flattenTrace(tx, trace) : [], [tx, trace]);
  const evidence = useMemo(() => compareExecution(context, traces).filter(item => (txKey(item.plan.tx) === txKey(tx) || item.observations.some(observation => txKey(observation.tx) === txKey(tx))) && (!focused || item.plan.hash === focused)), [context, traces, tx, focused]);
  const load = async () => { setLoading(true); setError(null); try { await loadTrace(tx); } catch (err) { if (mounted.current) setError((err as Error).message); } finally { if (mounted.current) setLoading(false); } };
  useEffect(() => { if (tab === 'calls' && !trace) void load(); }, [tab]); // cache requests in parent; entering Calls restores the saved trace
  const jumpFailure = () => { if (!trace) return; const path = firstFailurePath(tx, trace); setTraceFocus(path); if (path) requestAnimationFrame(() => document.querySelector(`[data-trace-path="${path}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); };
  return <article className={styles.inspector} aria-label="Execution inspector">
    <div className={styles.cardHeader}><h2>{tab === "flow" ? "Execution flow" : `${tx.chain.toUpperCase()} transaction`}</h2><span className={tab !== 'flow' && tx.receipt?.status === '0x0' ? styles.failed : styles.muted}>{tab === 'flow' ? 'L1 ↔ L2' : !tx.receipt ? 'Receipt unavailable / pending' : tx.receipt.status === '0x1' ? 'Success' : 'Reverted'}</span></div>
    {tab !== "flow" && <><ExplorerLink value={tx.tx.hash} type="tx" chain={tx.chain} short />
    <div className={styles.inspectorSummary}><span>{tx.payload?.method ?? 'Transaction'}</span><span>{quantity(tx.receipt?.gasUsed)} gas</span><span>{events.length} EEZ events</span></div></>}
    {tx.warnings.map(warning => <p className={styles.warning} key={warning}>{warning}</p>)}
    <nav className={styles.inspectorTabs} aria-label="Inspector views">{(['flow', 'timeline', 'calls', 'entries', 'raw'] as const).map(item => <button key={item} aria-pressed={tab === item} className={`btn btn-sm ${tab === item ? 'btn-solid' : 'btn-outline'}`} onClick={() => onTab(item)}>{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</nav>
    {tab === 'flow' && <ExecutionFlow detailAction={flowDetailAction} onDetailAction={onFlowDetailAction} context={context} tx={tx} traces={traces} loadTrace={loadTrace} step={step} onFocus={onFocus} onSelect={onSelect} onCalls={() => onTab('calls')} onTimeline={() => onTab('timeline')} />}
    {tab === 'timeline' && <ExecutionTimeline context={context} tx={tx} step={step} focused={focused} onFocus={onFocus} onSelect={onSelect} onCalls={() => onTab('calls')} onEntries={() => onTab('entries')} />}
    {tab === 'calls' && <section className={styles.section}><div className={styles.cardHeader}><h3>Call trace</h3><div className={styles.buttons}><button className="btn btn-sm btn-outline" onClick={() => void load()} disabled={loading || !!trace}>{loading ? 'Loading trace…' : trace ? 'Trace cached' : 'Load trace'}</button>{trace && <button className="btn btn-sm btn-outline" disabled={!firstFailurePath(tx, trace)} onClick={jumpFailure}>Jump to failure</button>}</div></div>
      {error && <p className={styles.warning} role="status">Trace unavailable: {error}. Receipt and raw data remain available.</p>}
      {trace && <><p className={styles.muted}>{frames.length} frames · {frames.filter(frame => frame.classification === 'Unexpected failure').length} unexpected failures · {frames.filter(frame => frame.classification === 'Expected revert').length} expected reverts · {frames.filter(frame => frame.classification === 'Handled revert').length} handled reverts</p><TraceNode trace={trace} chain={tx.chain} path="0" frames={frames} focus={traceFocus} /></>}
    </section>}
    {tab === 'entries' && <section className={styles.section}><div className={styles.cardHeader}><h3>Expected vs observed</h3><div className={styles.buttons}>{focused && <button className="btn btn-sm btn-outline" onClick={() => onFocus(null)}>Show all entries</button>}<button className="btn btn-sm btn-outline" disabled={!evidence.some(item => item.state === 'Mismatch')} onClick={() => { const item = evidence.find(item => item.state === 'Mismatch'); if (item) { setEntryFocus(item.plan.id); requestAnimationFrame(() => document.getElementById(item.plan.id)?.scrollIntoView({ block: 'center' })); } }}>Jump to mismatch</button></div></div>
      <p className={styles.muted}>Checks use loaded transactions and cached traces. Missing evidence is not a failure; expected reverts may erase entry logs.</p>
      {!evidence.length && <p className={styles.muted}>No planned entries for this transaction{focused ? ' and focused hash' : ''}.</p>}
      {evidence.map(item => <details id={item.plan.id} key={item.plan.id} className={`${styles.entry} ${entryFocus === item.plan.id ? styles.activeStep : ''}`} open={entryFocus === item.plan.id}>
        <summary><strong>{item.plan.kind} entry {item.plan.index}</strong><span className={styles.evidenceBadge} data-state={item.state}>{item.state}</span><span>{item.checks.filter(check => check.state === 'Match').length} / {item.checks.length} checks match</span></summary>
        <p className={styles.muted}>Planned on {item.plan.tx.chain.toUpperCase()} <ExplorerLink value={item.plan.tx.tx.hash} chain={item.plan.tx.chain} type="tx" short /></p><div className={styles.evidenceChecks}>{item.checks.map(check => <div key={check.field} className={styles.evidenceCheck}><div className={styles.cardHeader}><strong>{check.field}</strong><span className={styles.evidenceBadge} data-state={check.state}>{check.state}</span></div><dl className={styles.fields}><dt>Expected</dt><dd><code>{typeof check.expected === 'string' ? check.expected : jsonDebug(check.expected)}</code></dd><dt>Observed</dt><dd><code>{check.observed === undefined ? 'No recorded evidence' : typeof check.observed === 'string' ? check.observed : jsonDebug(check.observed)}</code></dd></dl>{check.detail && <p className={styles.muted}>{check.detail}</p>}</div>)}</div>
        <RawData value={item.plan.entry} label="Entry parameters" />
      </details>)}
      {tx.payload && <Payload payload={tx.payload} chain={tx.chain} />}
      {!tx.payload && events.filter(event => event.name === 'ExecutionTableLoaded').map((event, i) => <Payload key={i} chain={tx.chain} payload={{ method: 'ExecutionTableLoaded', args: event.args, entries: event.args.entries as Record<string, unknown>[], staticEntries: event.args.staticEntries as Record<string, unknown>[], immediateEntryCount: 0 }} />)}
    </section>}
    {tab === 'raw' && <section className={styles.section}><dl className={styles.fields}><dt>Block</dt><dd>{tx.tx.blockNumber ? <ExplorerLink value={BigInt(tx.tx.blockNumber).toString()} type="block" chain={tx.chain} /> : 'Pending'}</dd><dt>From</dt><dd><ExplorerLink value={tx.tx.from} chain={tx.chain} /></dd><dt>To</dt><dd>{tx.tx.to ? <ExplorerLink value={tx.tx.to} chain={tx.chain} /> : 'Contract creation'}</dd><dt>Value</dt><dd>{quantity(tx.tx.value)} wei</dd></dl>
      <RawData value={tx.tx.input} label="Calldata" /><RawData value={tx.receipt?.logs ?? []} label={`Raw receipt logs (${tx.receipt?.logs.length ?? 0})`} /><RawData value={{ transaction: tx.tx, receipt: tx.receipt }} label="Transaction and receipt JSON" />{trace && <RawData value={trace} label="Cached call trace JSON" />}
    </section>}
  </article>;
}
