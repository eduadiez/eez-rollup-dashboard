import { useMemo } from 'react';
import { txKey } from '../../lib/executionAnalysis';
import { alignTimelineRows, buildExecutionTimeline, timelineClock, timelineEventJson, timelinePosition, timelineTransactionTitle, type TimelineRow, type TimelineStep } from '../../lib/executionTimeline';
import { quantity, type DebugContext, type DebugTransaction } from '../../lib/executionDebugger';
import { ExplorerLink } from '../ExplorerLink';
import styles from './ExecutionDebugger.module.css';

export function ExecutionTimeline({ context, tx, step, focused, onFocus, onSelect, onCalls, onEntries }: {
  context: DebugContext; tx: DebugTransaction; step: number; focused: string | null;
  onFocus: (hash: string | null) => void; onSelect: (tx: DebugTransaction, event?: number, hash?: string) => void;
  onCalls: () => void; onEntries: () => void;
}) {
  const timeline = useMemo(() => buildExecutionTimeline(context, tx), [context, tx]);
  const rows = useMemo(() => alignTimelineRows(timeline), [timeline]);
  const stepsById = new Map(timeline.steps.map(item => [item.id, item]));
  const activeId = `${txKey(tx)}:${step}`;
  const currentIndex = rows.findIndex(row => row.l1?.id === activeId || row.l2?.id === activeId);
  const activeRow = rows[currentIndex];
  const rowByEvent = new Map(rows.flatMap((row, index) => [row.l1, row.l2].flatMap(item => item ? [[item.id, index] as const] : [])));
  const transactions = new Map([...timeline.chains.l1, ...timeline.chains.l2].map(group => [txKey(group.tx), group]));
  const selectedIds = new Set([activeRow?.l1?.id, activeRow?.l2?.id]);
  const linkedIds = new Set(timeline.connections.flatMap(connection => selectedIds.has(connection.from) ? [connection.to] : selectedIds.has(connection.to) ? [connection.from] : []));
  const aligned = new Set(rows.flatMap(row => row.connection ? [row.connection] : []));
  const spanning = timeline.connections.filter(connection => !aligned.has(connection));
  const choose = (target: TimelineStep) => {
    onFocus(target.hash); onSelect(target.tx, target.eventIndex, target.hash ?? undefined);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-timeline-step="${target.id}"]`)?.closest('[data-timeline-row]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };
  const chooseRow = (row: TimelineRow) => {
    const target = row[tx.chain] ?? row.l1 ?? row.l2;
    if (target) choose(target);
  };
  const inspectCalls = (item: TimelineStep) => { onFocus(item.hash); onSelect(item.tx, item.eventIndex, item.hash ?? undefined); onCalls(); };
  const transactionMeta = (item: TimelineStep | null) => {
    if (!item) return <div className={styles.timelineMetaEmpty} />;
    const group = transactions.get(txKey(item.tx))!;
    if (group.steps[0]?.id !== item.id) return <div className={styles.timelineMetaEmpty} />;
    return <div className={styles.timelineTransactionMeta}><strong>{item.tx.chain.toUpperCase()} · {timelineTransactionTitle(item.tx)}</strong><span className={item.tx.receipt?.status === '0x0' ? styles.failed : styles.muted}>{!item.tx.receipt ? 'Receipt unavailable / pending' : item.tx.receipt.status === '0x1' ? 'Success' : 'Reverted'}</span><ExplorerLink value={item.tx.tx.hash} chain={item.tx.chain} type="tx" short /><span>Block #{quantity(item.tx.tx.blockNumber)} · tx {quantity(item.tx.tx.transactionIndex)}</span><time>{timelineClock(group.timestamp)}{group.timestamp && ' · block time'}</time></div>;
  };
  const label = (row: TimelineRow, index: number) => `${index + 1}. ${row.connection ? `${stepsById.get(row.connection.from)!.tx.chain.toUpperCase()} → ${stepsById.get(row.connection.to)!.tx.chain.toUpperCase()} · ${stepsById.get(row.connection.to)!.title} · ${row.connection.basis}` : `${(row.l1 ?? row.l2)!.tx.chain.toUpperCase()} · ${(row.l1 ?? row.l2)!.title}`}`;
  const linkExplanation = (basis: string) => basis === 'Replay candidate' ? 'Candidate matched using the execution plan, source address, calldata and value. Destination and timing are not proven.' : 'Recorded calls share a hash. Repeated occurrences may still be ambiguous.';
  return <section className={styles.section} aria-label="Execution timeline">
    <div className={styles.cardHeader}><h3>Execution timeline</h3><span className={styles.muted}>{rows.length} steps · {timeline.steps.length} recorded events</span></div>
    <p className={styles.muted}>Linked L1 and L2 events share a row. Read down each column in log order. A shared row follows the same call, rather than a shared clock time.</p>
    <div className={styles.timelineControls} aria-label="Global timeline controls">
      <button className="btn btn-sm btn-outline" disabled={currentIndex <= 0} onClick={() => chooseRow(rows[currentIndex - 1]!)}>Previous step</button>
      <label><span>Step {currentIndex < 0 ? '—' : currentIndex + 1} of {rows.length}</span><select aria-label="Select timeline step" value={currentIndex} disabled={!rows.length} onChange={event => chooseRow(rows[Number(event.target.value)]!)}>
        {currentIndex < 0 && <option value={-1}>Choose a step</option>}{rows.map((row, index) => <option key={row.id} value={index}>{label(row, index)}</option>)}
      </select></label>
      <button className="btn btn-sm btn-outline" disabled={!rows.length || currentIndex >= rows.length - 1} onClick={() => chooseRow(rows[currentIndex + 1]!)}>Next step</button>
    </div>
    <div className={styles.timelineLegend}><span>↔ Matching call hash</span><span>⇢ Replay candidate</span><button className="btn btn-sm btn-outline" onClick={onEntries}>Inspect execution plan</button>{focused && <button className="btn btn-sm btn-outline" onClick={() => onFocus(null)}>Clear call highlight</button>}</div>
    {spanning.length > 0 && <details className={styles.timelineLinkNote}><summary>{spanning.length} additional call link{spanning.length === 1 ? '' : 's'} across steps</summary><p>Nested calls can complete later in the other column. Their links jump to the corresponding step while preserving both chains’ log order. Ambiguous candidates stay separate.</p></details>}
    <div className={styles.timelineColumnHeaders}>{(['l1', 'l2'] as const).map(chain => <div key={chain} data-timeline-chain={chain} className={styles.executionChainHeader}><strong>{chain.toUpperCase()}</strong><span>{timeline.chains[chain].length} EEZ txs · {timeline.chains[chain].reduce((count, group) => count + group.steps.length, 0)} events</span></div>)}</div>
    <ol className={styles.alignedTimeline}>{rows.map((row, index) => {
      const selected = index === currentIndex;
      const source = row.connection && stepsById.get(row.connection.from)!;
      const target = row.connection && stepsById.get(row.connection.to)!;
      return <li key={row.id} data-timeline-row={index + 1} data-selected={selected} data-aligned={!!row.connection} className={styles.timelineRow}>
        <div className={styles.timelineRowHeader}><button aria-label={`Select step ${index + 1} on both chains`} aria-pressed={selected} onClick={() => chooseRow(row)}>Step {index + 1}</button>{row.connection && source && target && <span data-connection-basis={row.connection.basis} title={linkExplanation(row.connection.basis)}>{source.tx.chain.toUpperCase()} → {target.tx.chain.toUpperCase()} · {row.connection.basis === 'Matching call hash' ? '↔ Matching call hash' : '⇢ Replay candidate'}</span>}</div>
        {[row.l1, row.l2].some(item => item && transactions.get(txKey(item.tx))!.steps[0]?.id === item.id) && <div className={styles.timelineRowMeta}>{transactionMeta(row.l1)}{transactionMeta(row.l2)}</div>}
        <div className={styles.timelineRowCells} aria-label={selected ? 'Selected timeline step' : undefined}>{(['l1', 'l2'] as const).map(chain => {
          const item = row[chain];
          if (!item) return <div key={chain} className={styles.timelineEmpty} aria-label={`No linked ${chain.toUpperCase()} event in this step`}><span>—</span></div>;
          const links = timeline.connections.filter(connection => (connection.from === item.id || connection.to === item.id) && connection !== row.connection);
          const linked = linkedIds.has(item.id) || !!focused && item.hash === focused;
          return <div key={chain} data-timeline-chain={chain} data-timeline-step={item.id} data-event-index={item.eventIndex} data-kind={item.kind} data-result={item.event.name === 'CallResult' && item.event.args.success === false ? 'revert' : undefined} className={`${styles.executionStep} ${selected ? styles.executionSelected : linked ? styles.executionLinked : ''}`}>

            <button className={styles.executionStepButton} aria-label={`${chain.toUpperCase()} step ${item.order}: ${item.title}`} aria-pressed={selected} onClick={() => choose(item)}>
              <span className={styles.executionOrder}>{chain.toUpperCase()}</span><span className={styles.executionAction}><strong>{item.title}</strong><span>{item.description}</span><small>{item.event.name} · log {quantity(item.event.raw.logIndex)}</small></span>
            </button>
            {links.length > 0 && <div className={styles.executionConnections}>{links.map(connection => {
              const counterpart = stepsById.get(connection.from === item.id ? connection.to : connection.from)!;
              return <button key={`${connection.from}:${connection.to}`} className={styles.connectionButton} data-connection-basis={connection.basis} onClick={() => choose(counterpart)} title={linkExplanation(connection.basis)}>↔ {counterpart.tx.chain.toUpperCase()} · Step {rowByEvent.get(counterpart.id)! + 1}<span>{connection.ambiguous ? 'Ambiguous candidate' : connection.basis} · {counterpart.kind === 'Result' ? 'call result' : counterpart.event.name === 'EntryExecuted' ? 'entry completion' : counterpart.event.name === 'CrossChainCallExecuted' ? 'outgoing call' : counterpart.event.name === 'IncomingCrossChainCallExecuted' ? 'incoming call' : 'recorded event'}</span></button>;
            })}</div>}
            {selected && <div className={styles.selectedStepDetail}>
              <p className={styles.muted}>{timelinePosition(item)}</p>
              <button className="btn btn-sm btn-outline" onClick={() => inspectCalls(item)}>Inspect {chain.toUpperCase()} nested calls</button>
              <details className={styles.raw}><summary>{item.event.name} · event fields</summary><pre>{timelineEventJson(item)}</pre></details>
            </div>}
          </div>;
        })}</div>
      </li>;
    })}</ol>
    {[...timeline.chains.l1, ...timeline.chains.l2].filter(group => !group.steps.length).map(group => <div key={txKey(group.tx)} className={styles.timelineGap}><strong>{group.tx.chain.toUpperCase()} · {group.tx.receipt?.status === '0x0' ? 'Reverted transaction — logs rolled back' : !group.tx.receipt ? 'Recorded events unavailable' : 'No recorded EEZ events'}</strong><ExplorerLink value={group.tx.tx.hash} chain={group.tx.chain} type="tx" short /><p>Inspect the call trace to follow the internal execution.</p><button className="btn btn-sm btn-outline" onClick={() => { onFocus(null); onSelect(group.tx); onCalls(); }}>Inspect calls</button></div>)}
    {!timeline.steps.length && <p className={styles.muted}>There are no recorded protocol events in the loaded execution. Calls and Raw retain the available evidence.</p>}
  </section>;
}
