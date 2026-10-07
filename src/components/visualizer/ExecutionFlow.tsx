import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { txKey } from '../../lib/executionAnalysis';
import { buildExecutionFlow, flowTraceTransactions, flowReturnKind, flowExecutionConnections, otherChain, type FlowAction, type FlowStateUpdate } from '../../lib/executionFlow';
import { timelineEventJson } from '../../lib/executionTimeline';
import { jsonDebug, type CallTrace, type DebugContext, type DebugTransaction } from '../../lib/executionDebugger';
import { ExplorerLink } from '../ExplorerLink';
import styles from './ExecutionDebugger.module.css';

type FlowStep = FlowAction | FlowStateUpdate;
const rootLabel = (root: string) => `${root.slice(0, 6)}…${root.slice(-4)}`;
const addressLabel = (value?: string) => value?.length === 42 ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Unresolved';
export function ExecutionFlow({ context, tx, traces, loadTrace, step, detailAction, onDetailAction, onFocus, onSelect, onCalls, onTimeline }: {
  context: DebugContext; tx: DebugTransaction; traces: Record<string, CallTrace>; loadTrace: (tx: DebugTransaction) => Promise<CallTrace>; step: number;
  detailAction: string | null; onDetailAction: (action: string | null) => void;
  onFocus: (hash: string | null) => void; onSelect: (tx: DebugTransaction, event?: number, hash?: string) => void;
  onCalls: () => void; onTimeline: () => void;
}) {
  const traceTxs = useMemo(() => flowTraceTransactions(context, tx), [context, tx]);
  const traceScope = traceTxs.map(txKey).join(',');
  const [retry, setRetry] = useState(0), [pending, setPending] = useState(0), [failed, setFailed] = useState<DebugTransaction[]>([]);
  const loader = useRef(loadTrace); loader.current = loadTrace;
  const cached = useRef(traces); cached.current = traces;
  useEffect(() => {
    let stopped = false, cursor = 0, remaining = 0;
    const queue = traceTxs.filter(item => !cached.current[txKey(item)]); remaining = queue.length; setPending(remaining); setFailed([]);
    const work = async () => {
      while (!stopped && cursor < queue.length) {
        const item = queue[cursor++]!;
        try { await loader.current(item); } catch { if (!stopped) setFailed(old => [...old, item]); }
        finally { if (!stopped) setPending(--remaining); }
      }
    };
    void work(); void work(); return () => { stopped = true; };
  }, [traceScope, retry]);
  const flow = useMemo(() => buildExecutionFlow(context, tx, traces), [context, tx, traces]);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760), [chosen, setChosen] = useState<string | null>(null);
  const marker = useId().replace(/:/g, '');
  const [detailPanel, setDetailPanel] = useState<HTMLDivElement | null>(null);
  const [detailHeight, setDetailHeight] = useState(220);
  useLayoutEffect(() => {
    const element = container.current; if (!element) return;
    const resize = () => setWidth(Math.max(260, Math.floor(element.clientWidth) - 2));
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, []);
  const requested = `${txKey(tx)}:${step}`;
  const steps: FlowStep[] = flow.entries.flatMap(entry => [...entry.actions, ...entry.updates]);
  const matchesSelection = (action: FlowStep) => action.anchor ? action.anchor.id === requested : action.kind === 'state' && txKey(action.plan.tx) === txKey(tx);
  const activeStep = steps.find(action => action.id === detailAction && matchesSelection(action)) ??
    steps.find(action => action.id === chosen && matchesSelection(action)) ??
    steps.find(action => action.anchor?.id === requested) ??
    steps.find(action => action.anchor && txKey(action.anchor.tx) === txKey(tx) && action.anchor.eventIndex >= step) ??
    [...steps].reverse().find(action => action.anchor && txKey(action.anchor.tx) === txKey(tx)) ?? steps[0];
  const active = activeStep?.kind !== 'state' ? activeStep : undefined;
  useEffect(() => {
    if (active && !pending && !flow.nodes.some(node => node.id === requested) && active.anchor.id !== requested && txKey(active.anchor.tx) === txKey(tx)) {
      onFocus(active.anchor.hash); onSelect(active.anchor.tx, active.anchor.eventIndex, active.anchor.hash ?? undefined);
    }
  }, [active, requested, tx, pending, flow.nodes, onFocus, onSelect]);
  useLayoutEffect(() => {
    const element = detailPanel; if (!element) return;
    const resize = () => { if (element.isConnected) setDetailHeight(Math.ceil(element.offsetHeight)); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, [detailPanel, width]);
  const detailsOpen = !!activeStep && activeStep.id === detailAction;
  const current = activeStep ? steps.indexOf(activeStep) : -1;
  const choose = (action: FlowStep, inspect = false) => {
    setChosen(action.id); onDetailAction(inspect && !detailsOpen ? action.id : null); const node = action.anchor;
    if (node) { onFocus(node.hash); onSelect(node.tx, node.eventIndex, node.hash ?? undefined); }
    else if (action.kind === 'state') { onFocus(null); onSelect(action.plan.tx, 0); }
    requestAnimationFrame(() => {
      document.querySelector(`[data-flow-action="${action.id}"]`)?.scrollIntoView({ block: inspect ? 'nearest' : 'center', behavior: 'smooth' });
    });
  };
  const pill = width < 500 ? 82 : 146;
  const maxDepth = Math.max(1, ...flow.actions.map(action => action.depth));
  const indent = Math.min(width < 500 ? 10 : 28, Math.max(0, (width - 2 * pill - 36 - 44) / (2 * maxDepth)));
  const lane = (chain: 'l1' | 'l2', depth = 0) => chain === 'l1' ? pill / 2 + 18 + depth * indent : width - pill / 2 - 18 - depth * indent;
  const visibleEntries = flow.entries.filter(entry => entry.calls.length || entry.updates.length);
  const emptyEntries = flow.entries.filter(entry => !entry.calls.length && !entry.updates.length);
  const stepLabel = (action: FlowStep) => action.kind === 'state' ? `L1 entry ${action.plan.index} · L2 state update · ${action.status}` : `C${action.call.number} · ${action.kind === 'request' ? `${action.call.source.tx.chain.toUpperCase()} → ${otherChain(action.call.source.tx.chain).toUpperCase()}` : `${flowReturnKind(action.call) === 'local' ? 'Cached result on' : flowReturnKind(action.call) === 'unavailable' ? 'Return unavailable on' : 'Return to'} ${action.call.source.tx.chain.toUpperCase()}`}`;
  const detailNodes = active ? [active.call.source, active.call.target].filter(node => !!node)
    .sort((a, b) => a.tx.chain === b.tx.chain ? 0 : a.tx.chain === 'l1' ? -1 : 1) : [];
  const orphaned = flow.nodes.filter(node => !flow.calls.some(call => call.source.id === node.id || call.target?.id === node.id));
  const inlineDetails = active && detailsOpen ? <div key={active.id} data-flow-details role="region" aria-label={`C${active.call.number} call details`} className={styles.flowInlineDetails}><p className={styles.muted}>{active.call.basis}{active.call.basis === 'Replay candidate' && ' · source, calldata and value match the planned dispatch; traces locate nested execution. Cross-chain timing is not implied.'}</p><div className={styles.flowDetailGrid}>{detailNodes.map(node => <div key={node.id} data-chain={node.tx.chain}><strong>{node.tx.chain.toUpperCase()}</strong><ExplorerLink value={node.tx.tx.hash} chain={node.tx.chain} type="tx" short /><div className={styles.buttons}><button className="btn btn-sm btn-outline" onClick={() => { onSelect(node.tx, node.eventIndex, node.hash ?? undefined); onCalls(); }}>{node.tx.chain.toUpperCase()} call trace</button><button className="btn btn-sm btn-outline" onClick={() => { onSelect(node.tx, node.eventIndex, node.hash ?? undefined); onTimeline(); }}>Event in timeline</button></div><details className={styles.raw}><summary>Event fields</summary><pre>{timelineEventJson(node)}</pre></details></div>)}</div><details className={styles.raw}><summary>Return evidence</summary><pre>{jsonDebug({ result: active.call.result ?? 'No recorded return', returnPath: flowReturnKind(active.call), callerAndDestinationDiffer: active.call.mismatch })}</pre></details></div> : null;
  return <section className={styles.section} aria-label="L1 and L2 execution flow">
    <div className={styles.cardHeader}><h3>Execution flow</h3><span className={styles.muted}>{flow.calls.length} calls · {visibleEntries.length} entry groups</span></div>
    {!!steps.length && <div className={styles.flowControls} aria-label="Global flow controls"><button className="btn btn-sm btn-outline" disabled={current <= 0} onClick={() => choose(steps[current - 1]!)}>Previous step</button><label><span>Step {current + 1} / {steps.length}</span><select aria-label="Select flow step" value={current} onChange={event => choose(steps[Number(event.target.value)]!)}>{steps.map((action, index) => <option key={action.id} value={index}>{index + 1}. {stepLabel(action)}</option>)}</select></label><button className="btn btn-sm btn-outline" disabled={current >= steps.length - 1} onClick={() => choose(steps[current + 1]!)}>Next step</button></div>}
    <div className={styles.flowLegend}><span><i />Matched call</span><span><i data-dashed />Return</span><span><i data-candidate />Candidate</span><span>↓ Execution</span><span>Same level: sequential calls · ↳ Indented: nested calls</span></div>
    {pending > 0 && <p className={styles.muted} role="status">Aligning calls and returns… {pending} traces remaining</p>}
    {!!failed.length && <p className={styles.muted} role="status">{failed.length} traces unavailable. Unresolved calls stay unlinked. <button className="btn btn-sm btn-outline" onClick={() => setRetry(value => value + 1)}>Retry traces</button></p>}
    <div ref={container} className={styles.flowEntries}>
      {visibleEntries.map((entry, entryIndex) => {
        const selectedIndex = entry.actions.findIndex(action => action.id === active?.id);
        const detailGap = detailsOpen && selectedIndex >= 0 ? detailHeight + 12 : 0;
        const rowY = (index: number) => 94 + index * 92 + (selectedIndex >= 0 && index > selectedIndex ? detailGap : 0);
        const detailTop = selectedIndex >= 0 ? rowY(selectedIndex) + 36 : 0;
        return <section key={entry.id} className={styles.flowEntry} data-flow-entry={entryIndex}>
        <div className={styles.flowEntryHeader}><strong>{entry.plans.length ? entry.plans.map(plan => `${plan.tx.chain.toUpperCase()} entry ${plan.index}`).join(' ↔ ') : 'Calls without an indexed entry'}</strong><span>{entry.calls.length ? `${entry.calls.length} calls` : 'Pure L2 transaction'}{entry.updates.length && entry.calls.length ? ' · Immediate state update' : ''}</span></div>
        <div className={styles.flowEntryTransactions}>{[...new Map(entry.plans.map(plan => [txKey(plan.tx), plan.tx])).values()].map(item => <span key={txKey(item)}>{item.chain.toUpperCase()} <ExplorerLink value={item.tx.hash} chain={item.chain} type="tx" short /></span>)}</div>
        {!!entry.actions.length && <svg viewBox={`0 0 ${width} ${48 + entry.actions.length * 92 + detailGap}`} role="group" aria-label="Interactive L1 and L2 call diagram" className={styles.flowDiagram} data-compact={width < 500}>
          <defs>{(['l1', 'l2'] as const).flatMap(chain => [false, true].map(execution => <marker key={`${chain}-${execution}`} id={`${marker}-${entryIndex}-${chain}${execution ? '-execution' : ''}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth={execution ? 5 : 7} markerHeight={execution ? 5 : 7} orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" className={styles.flowArrowHead} data-chain={chain} /></marker>))}</defs>
          {entry.actions.filter(action => action.kind === 'request' && action.depth > 0).map(action => {
            const start = entry.actions.indexOf(action), end = entry.actions.findIndex(item => item.call.id === action.call.id && item.kind === 'return');
            const inset = 4 + action.depth * indent;
            return <rect key={action.id} x={inset} y={rowY(start) - 56} width={width - 2 * inset} height={rowY(Math.max(start, end)) - rowY(start) + 88} rx={6} className={styles.flowNestedScope} data-flow-nesting={action.call.number} data-depth={action.depth}><title>C{action.call.number} · nested in C{flow.calls.find(parent => parent.id === action.call.parent)?.number}</title></rect>;
          })}
          {entry.actions.map((action, index) => <rect key={action.id} x={0} y={rowY(index) - 56} width={width} height={88} rx={6} className={styles.flowRowHighlight} data-selected={action.id === active?.id} />)}
          {(['l1', 'l2'] as const).map(chain => <g key={chain} data-flow-lane={chain}><text x={lane(chain)} y={24} textAnchor="middle" className={styles.flowLaneTitle} data-chain={chain}>{chain.toUpperCase()}</text><line x1={lane(chain)} x2={lane(chain)} y1={36} y2={42 + entry.actions.length * 92 + detailGap} className={styles.flowLifeline} /></g>)}
          {entry.actions.map((action, index) => {
            const call = action.call, returning = action.kind === 'return', returnKind = flowReturnKind(call);
            const remoteReturn = returning && returnKind === 'cross-chain';
            const sourceChain = remoteReturn ? otherChain(call.source.tx.chain) : call.source.tx.chain;
            const targetChain = returning && !remoteReturn ? sourceChain : otherChain(sourceChain);
            const direction = sourceChain === 'l1' ? 1 : -1, y = rowY(index);
            const sx = lane(sourceChain, action.depth) + direction * (pill / 2 + 3), ex = lane(targetChain, action.depth) - direction * (pill / 2 + 7);
            const selected = action.id === active?.id, warning = call.mismatch || returning && call.result?.success === false;
            const title = `C${call.number} · ${returning ? call.result ? call.result.success ? returnKind === 'local' ? 'cached result' : 'return' : 'revert' : 'no return' : 'call'}`;
            const label = returning ? call.result ? `${(call.result.data.length - 2) / 2} bytes` : 'Unavailable' : String(call.source.event.args.callData ?? '0x').slice(0, 10);
            return <g key={action.id} role="button" tabIndex={0} aria-label={stepLabel(action)} aria-pressed={selected} aria-expanded={selected && detailsOpen} data-flow-action={action.id} data-flow-call={call.number} data-call-hash={call.source.hash ?? undefined} data-kind={action.kind} data-depth={action.depth} data-source-chain={sourceChain} data-target-chain={targetChain} data-selected={selected} data-basis={call.basis} data-return-kind={returning ? returnKind : undefined} data-call-origin={call.source.tx.chain} data-warning={warning} className={styles.flowAction} onClick={() => choose(action, true)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(action, true); } }}>
              <title>{stepLabel(action)}{call.parent ? ` · nested in C${flow.calls.find(parent => parent.id === call.parent)?.number}` : ''} · {call.basis}{returning ? ` · ${call.result?.evidence ?? 'Return unavailable'}` : ''}{call.mismatch ? ' · caller and destination results differ' : ''}</title>
              <rect x={0} y={y - 56} width={width} height={88} rx={6} className={styles.flowRowHit} />
              <text x={width / 2} y={y - 37} textAnchor="middle" className={styles.flowNodeTitle}>{action.depth > 0 ? '↳ ' : ''}{title}</text><text x={width / 2} y={y - 23} textAnchor="middle" className={styles.flowNodeDetail}>{label}</text>
              <g className={styles.flowLink} data-chain={call.source.tx.chain} data-selected={selected}>
                {(!returning || remoteReturn) && <path d={`M ${sx} ${y} L ${call.target ? ex : width / 2} ${y}`} className={styles.flowLinkLine} strokeDasharray={returning ? '5 4' : call.basis !== 'Matching call hash' ? '2 4' : undefined} markerEnd={call.target ? `url(#${marker}-${entryIndex}-${call.source.tx.chain})` : undefined} />}
                {returning && returnKind === 'local' && <path d={`M ${sx} ${y - 12} L ${sx + direction * 20} ${y - 12} Q ${sx + direction * 32} ${y}, ${sx + direction * 20} ${y + 12} L ${sx} ${y + 12}`} className={styles.flowLinkLine} strokeDasharray="5 4" markerEnd={`url(#${marker}-${entryIndex}-${call.source.tx.chain})`} />}
              </g>
              {(['l1', 'l2'] as const).map(chain => {
                const caller = chain === call.source.tx.chain, observed = caller || !!call.destination;
                if (!caller && returning && !remoteReturn) return <text key={chain} x={lane(chain, action.depth)} y={y + 4} textAnchor="middle" className={styles.flowUnresolved}>Unresolved</text>;
                return <g key={chain} transform={`translate(${lane(chain, action.depth)},${y})`} data-chain={chain} className={styles.flowNode} data-selected={selected} data-observed={observed}>
                  <rect x={-pill / 2} y={-22} width={pill} height={44} rx={6} /><text y={-3} textAnchor="middle" className={styles.flowNodeTitle}>{addressLabel(caller ? call.caller : call.destination)}</text><text y={12} textAnchor="middle" className={styles.flowNodeDetail}>{caller ? returning && call.result?.evidence === 'Caller trace' ? 'Caller resumes' : 'Caller' : returning ? 'Result' : 'Destination'}</text>
                </g>;
              })}
              <text x={width / 2} y={y + 24} textAnchor="middle" className={styles.flowNodeDetail}>{warning ? call.mismatch ? 'Mismatch' : 'Reverted' : returning && call.result ? returnKind === 'local' ? 'Caller trace only' : 'Success' : call.basis === 'Replay candidate' ? 'Candidate' : call.basis === 'Unlinked' ? 'Unlinked' : ''}</text>
            </g>;
          })}
          {detailsOpen && selectedIndex >= 0 && <foreignObject x={14} y={detailTop} width={width - 28} height={detailHeight} data-flow-inline-details={active?.id}>
            <div ref={setDetailPanel} className={styles.flowInlinePanel}>{inlineDetails}</div>
          </foreignObject>}
          {flowExecutionConnections(entry).map(connection => {
            const fromIndex = entry.actions.indexOf(connection.from), toIndex = entry.actions.indexOf(connection.to);
            const start = rowY(fromIndex) + 24, end = rowY(toIndex) - 29;
            const fromX = lane(connection.chain, connection.from.depth), toX = lane(connection.chain, connection.to.depth), middle = (start + end) / 2;
            const crossesDetails = detailGap > 0 && selectedIndex >= fromIndex && selectedIndex < toIndex;
            const gutter = connection.chain === 'l1' ? 6 : width - 6;
            const path = crossesDetails
              ? `M ${fromX} ${start} V ${detailTop - 6} H ${gutter} V ${detailTop + detailHeight + 6} H ${toX} V ${end}`
              : fromX === toX ? `M ${fromX} ${start} V ${end}` : `M ${fromX} ${start} V ${middle} H ${toX} V ${end}`;
            const selected = connection.from.id === active?.id || connection.to.id === active?.id;
            return <g key={connection.id} role="button" tabIndex={0} aria-label={`${connection.chain.toUpperCase()} execution from C${connection.from.call.number} ${connection.from.kind} to C${connection.to.call.number} ${connection.to.kind}`} data-flow-execution={connection.id} data-chain={connection.chain} data-call-origin={connection.call.source.tx.chain} data-from={connection.from.id} data-to={connection.to.id} data-selected={selected} className={styles.flowExecution} onClick={() => choose(connection.to, true)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(connection.to, true); } }}>
              <title>{connection.chain.toUpperCase()} · execution continues on this chain</title>
              <rect x={toX - 8} y={end - 12} width={16} height={12} className={styles.flowExecutionHit} />
              <path d={path} className={styles.flowExecutionPathHit} />
              <path d={path} className={styles.flowExecutionLine} markerEnd={`url(#${marker}-${entryIndex}-${connection.call.source.tx.chain}-execution)`} />
            </g>;
          })}
        </svg>}
        {entry.updates.map(update => {
          const selected = activeStep?.id === update.id, open = selected && detailsOpen;
          return <div key={update.id} className={styles.flowStateUpdate} data-flow-state-update={update.id} data-status={update.status}>
            <svg viewBox={`0 0 ${width} ${104 * update.rollups.length}`} className={styles.flowDiagram} data-compact={width < 500} role="group" aria-label="Immediate L2 state commitment on L1">
              <defs><marker id={`${marker}-${entryIndex}-state-${update.plan.index}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth={5} markerHeight={5} orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" className={styles.flowArrowHead} data-chain="l2" /></marker></defs>
              {update.rollups.map((rollup, index) => {
                const y = 58 + index * 104;
                return <g key={rollup.rollupId} role="button" tabIndex={0} aria-label={stepLabel(update)} aria-expanded={open} aria-pressed={selected} data-flow-action={update.id} data-kind="state" data-selected={selected} className={styles.flowAction} onClick={() => choose(update, true)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(update, true); } }}>
                  <title>Rollup {rollup.rollupId}: {rollup.currentRoot} → {rollup.newRoot} · {update.status}. State commitment, not a cross-chain call.</title>
                  <rect x={0} y={y - 54} width={width} height={100} className={styles.flowRowHighlight} data-selected={selected} /><rect x={0} y={y - 54} width={width} height={100} className={styles.flowRowHit} />
                  <text x={width / 2} y={y - 34} textAnchor="middle" className={styles.flowNodeTitle}>State update</text><text x={width / 2} y={y - 20} textAnchor="middle" className={styles.flowNodeDetail}>Rollup {rollup.rollupId}</text>
                  <g className={styles.flowLink} data-chain="l2" data-selected={selected}><path d={`M ${lane('l2') - pill / 2 - 3} ${y} H ${lane('l1') + pill / 2 + 7}`} className={styles.flowLinkLine} strokeDasharray={update.status === 'Applied' ? undefined : '2 4'} markerEnd={update.status === 'Applied' ? `url(#${marker}-${entryIndex}-state-${update.plan.index})` : undefined} /></g>
                  {(['l1', 'l2'] as const).map(chain => <g key={chain} transform={`translate(${lane(chain)},${y})`} className={styles.flowNode} data-chain={chain} data-selected={selected} data-observed={chain === 'l2' || !!rollup.observed}>
                    <rect x={-pill / 2} y={-22} width={pill} height={44} rx={6} /><text y={-3} textAnchor="middle" className={styles.flowNodeTitle}>{chain === 'l1' ? 'L1 commitment' : 'L2 state'}</text><text y={12} textAnchor="middle" className={styles.flowNodeDetail}>{rootLabel(chain === 'l1' && rollup.observed ? String(rollup.observed.event.args.newRoot) : rollup.newRoot)}</text>
                  </g>)}
                  <text x={width / 2} y={y + 26} textAnchor="middle" className={styles.flowNodeDetail}>{update.status}</text>
                </g>;
              })}
            </svg>
            {open && <div className={styles.flowInlinePanel} data-flow-details data-flow-inline-details={update.id} role="region" aria-label="Immediate entry state update details">
              <p className={styles.muted}>L1 entry {update.plan.index} · {update.status}{!entry.calls.length ? ' · No cross-chain calls' : ''}</p>
              <div className={styles.flowStateRoots}>{update.rollups.map(rollup => <div key={rollup.rollupId}><strong>Rollup {rollup.rollupId}</strong><span>Previous root</span><code>{rollup.currentRoot}</code><span>New root</span><code>{rollup.newRoot}</code><span>Ether balance change: {rollup.etherDelta} wei</span></div>)}</div>
              {update.status !== 'Applied' && <p className={styles.muted}>{update.status === 'Skipped' ? 'The immediate entry was skipped; its planned state update was not applied.' : update.status === 'Mismatch' ? 'The recorded L1 root differs from the planned root. Inspect the receipt evidence below.' : 'The planned roots are shown. Matching completion and root-update receipt evidence is needed to confirm application.'}</p>}
              <ExplorerLink value={update.plan.tx.tx.hash} chain="l1" type="tx" short />
              {update.anchor && <div className={styles.buttons}><button className="btn btn-sm btn-outline" onClick={() => { onSelect(update.anchor!.tx, update.anchor!.eventIndex); onTimeline(); }}>Event in timeline</button></div>}
              <details className={styles.raw}><summary>State update evidence</summary><pre>{jsonDebug({ planned: update.plan.entry.rollupUpdates, recorded: update.rollups.map(rollup => rollup.observed?.event.args ?? null), entry: update.anchor?.event.args, status: update.status })}</pre></details>
            </div>}
          </div>;
        })}
      </section>; })}
    </div>
    {!!emptyEntries.length && <details className={styles.flowDetails} data-empty-entries><summary>{emptyEntries.length} entries without recorded cross-chain calls</summary>{emptyEntries.map(entry => <p key={entry.id}>{entry.plans.map(plan => `${plan.tx.chain.toUpperCase()} entry ${plan.index}`).join(' ↔ ')}</p>)}</details>}
    {!!orphaned.length && <details className={styles.flowDetails}><summary>{orphaned.length} unpaired events</summary>{orphaned.map(node => <p key={node.id}>{node.tx.chain.toUpperCase()} · {node.title} <button className="btn btn-sm btn-outline" onClick={() => { onSelect(node.tx, node.eventIndex, node.hash ?? undefined); onTimeline(); }}>Inspect event</button></p>)}</details>}
    {!flow.entries.length && <p className={styles.muted}>No recorded cross-chain calls or indexed entries in the loaded evidence.</p>}
  </section>;
}
