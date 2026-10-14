import { useEffect, useState, type FormEvent } from "react";
import { useDecodedTrace } from "../../hooks/useDecodedTrace";
import { config } from "../../config";
import { ExplorerLink } from "../ExplorerLink";
import { TraceDiagram, textValue } from "./TraceDiagram";
import type { TraceNode, TraceResult, TraceSource } from "../../../trace-decoder/service/types";
import styles from "./TraceDetailView.module.css";

function download(result: TraceResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = result.model.txHash + ".trace.json"; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CallInspector({ node }: { node: TraceNode | undefined }) {
  if (!node) return <aside className={styles.inspector}><h2>Call details</h2><p className={styles.muted}>Select a call to inspect its arguments, return value, and cross-chain evidence.</p></aside>;
  const chain = node.chain === "L1" ? "l1" : "l2", crossing = node.crossing || node.outgoing;
  return <aside className={styles.inspector} aria-label="Selected call details">
    <p className="eez-eyebrow">[ {node.chain} · {node.callType} ]</p>
    <h2>{node.contract}</h2><code>{node.signature || node.fn}</code>
    {node.address && <p><ExplorerLink value={node.address} chain={chain} /></p>}
    {(node.failed || node.reverted) && <p className={styles.warning}>This call reverted or occurred in a reverted context.</p>}
    {node.kind === "ghost" && <p className={styles.warning}>The remote execution has not been observed. Any precomputed return value is not proof of execution.</p>}
    <dl className={styles.fields}><dt>Value</dt><dd>{node.value} wei</dd><dt>Gas used</dt><dd>{node.gasUsed ?? "Not observed"}</dd>
      <dt>Transaction</dt><dd>{node.tx ? <ExplorerLink value={node.tx} type="tx" chain={chain} /> : "Not observed"}</dd>
      <dt>Block</dt><dd>{node.block !== null ? <ExplorerLink value={String(node.block)} type="block" chain={chain} /> : "Not observed"}</dd>
      {node.abiSource && <><dt>Decoded using</dt><dd>{node.abiSource}{node.abiProvider ? " · " + node.abiProvider : ""}</dd></>}
    </dl>
    {node.impl && <p className={styles.muted}>Implementation: <ExplorerLink value={node.impl.address} chain={chain} /></p>}
    <h3>Arguments</h3>
    {node.args.length ? node.args.map((argument, index) => <div className={styles.argument} key={index}>
      <span>{argument.name || "Argument " + (index + 1)} <small>{argument.type}</small></span><pre>{textValue(argument.value)}</pre>
    </div>) : <p className={styles.muted}>No decoded arguments.</p>}
    <h3>Return value</h3><p className={node.ret.status === "revert" ? styles.failure : styles.muted}>{node.ret.reason || node.ret.status}</p>
    {node.ret.items?.map((item, index) => <pre key={index}>{item.name ? item.name + ": " : ""}{textValue(item.value)}</pre>)}
    {crossing && <><h3>Cross-chain execution</h3><p>{crossing.from} → {crossing.to} · {crossing.status}</p>
      {crossing.remoteTx && <ExplorerLink value={crossing.remoteTx} type="tx" chain={crossing.to === "L1" ? "l1" : "l2"} />}
      {crossing.evidence.length > 0 && <ul>{crossing.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>}
    </>}
    <details><summary>Calldata and raw return</summary><h3>Input</h3><pre>{node.input}</pre><h3>Output</h3><pre>{node.output ?? node.ret.raw ?? "Not observed"}</pre></details>
  </aside>;
}
export function TraceDetailView({ hash, source, ready, onBack }: {
  hash: string; source: TraceSource; ready: boolean; onBack: () => void;
}) {
  const trace = useDecodedTrace(hash, source, ready);
  const [query, setQuery] = useState(hash);
  const [chain, setChain] = useState<TraceSource>(source);
  const [view, setView] = useState<"flow" | "sequence" | "raw">("flow");
  const [transaction, setTransaction] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const model = trace.result?.model;
  useEffect(() => { setSelected(null); setTransaction(""); }, [model]);
  const busy = trace.phase === "queued" || trace.phase === "running";
  const inspect = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!/^0x[0-9a-f]{64}$/i.test(value)) return;
    if (value.toLowerCase() === hash.toLowerCase() && chain === source) trace.refresh();
    else window.location.hash = "#/visualizer?mode=trace&chain=" + chain + "&tx=" + value;
  };
  const inspectorLink = "#/visualizer?mode=inspect&chain=" + source + "&tx=" + hash;
  return <main id="main" tabIndex={-1} className={styles.page}>
    <header className={styles.intro}>
      <button className="btn btn-sm btn-outline" onClick={onBack}>← Dashboard</button>
      <p className="eez-eyebrow">[ {config.rollupName} · TRANSACTION DETAILS ]</p>
      <h1 className="eez-page-heading">Follow the <strong>execution</strong></h1>
      <p className="eez-description">Explore the calls, return values, and related transactions across both chains.</p>
    </header>
    <form className={styles.searchBar} onSubmit={inspect}>
      <label>Source network<select value={chain} onChange={event => setChain(event.target.value as TraceSource)}>
        <option value="auto">Detect automatically</option><option value="l1">{config.l1NetworkName} · L1</option><option value="l2">{config.rollupName} · L2</option>
      </select></label>
      <label className={styles.query}>Transaction hash<input value={query} onChange={event => setQuery(event.target.value)}
        pattern="0x[a-fA-F0-9]{64}" required placeholder="0x…" spellCheck={false} /></label>
      <button className="btn btn-solid" disabled={!ready || busy}>Inspect</button>
      {hash && <a className="btn btn-outline" href={inspectorLink}>Blocks & settlement →</a>}
    </form>
    {!ready && <p className={styles.muted} role="status">Loading network configuration…</p>}
    {busy && <div className={styles.progress} role="status"><span className={styles.pulse} />{trace.progress}
      <button className="btn btn-sm btn-outline" onClick={trace.cancel}>Cancel</button></div>}
    {trace.error && <div className={styles.warning} role="alert"><p>{trace.error}</p>
      <button className="btn btn-sm btn-outline" onClick={trace.refresh}>Retry</button></div>}
    {trace.phase === "cancelled" && <p className={styles.muted} role="status">Decoding cancelled. <button className="btn btn-sm btn-outline" onClick={trace.refresh}>Retry</button></p>}
    {!hash && <p className={styles.empty}>Enter an L1 or L2 transaction hash to see its execution.</p>}
    {model && trace.result && <>
      <section className={styles.summary} aria-label="Trace summary">
        <div><h2>{model.label}</h2><p className={styles.muted}>Observed {new Date(trace.result.observedAt).toLocaleString()} · {model.stats.frames} frames · {model.stats.matched}/{model.stats.crossings} crossings matched</p></div>
        <div className={styles.actions}><button className="btn btn-sm btn-outline" onClick={trace.refresh}>Refresh</button>
          <button className="btn btn-sm btn-outline" onClick={() => trace.result && download(trace.result)}>Download JSON</button></div>
      </section>
      {trace.result.partial && <div className={styles.warning} role="status"><strong>Some evidence is missing</strong>
        <p>The diagram shows the available data. Missing traces or settlement data do not establish success or failure.</p>
        <ul>{model.unresolved.slice(0, 8).map((item, index) => <li key={index}>{item.message}</li>)}</ul>
        {model.unresolved.length > 8 && <p>{model.unresolved.length - 8} more diagnostics are included in the JSON download.</p>}
      </div>}
      <section className={styles.transactions} aria-label="Related transactions">
        <h2>Transactions</h2><p className={styles.muted}>Roles describe each transaction's part in execution. Transactions sharing a batch are not necessarily part of this call.</p>
        <div className={styles.transactionList}>{model.transactions.map(tx => <div key={tx.chain + tx.hash} className={styles.transaction} data-selected={transaction === tx.chain + ":" + tx.hash}>
          <span className={styles.chain} data-chain={tx.chain}>{tx.chain}</span>
          <button className={styles.textButton} onClick={() => { setTransaction(tx.chain + ":" + tx.hash); setSelected(null); }}><strong>{tx.label}</strong><span>{tx.requested ? "Requested · " : ""}{tx.status}{!tx.traced ? " · trace unavailable" : ""}</span></button>
          <ExplorerLink value={tx.hash} type="tx" chain={tx.chain === "L1" ? "l1" : "l2"} />
        </div>)}</div>
        {transaction && <button className="btn btn-sm btn-outline" onClick={() => setTransaction("")}>Show connected flow</button>}
      </section>
      {model.settlements.length > 0 && <section className={styles.settlements} aria-label="Observed settlement">
        <h2>L1 posting observed</h2><p className={styles.muted}>This is a snapshot of the verified posting. Open Blocks & settlement for current safety and finality.</p>
        {model.settlements.map(item => <div key={item.id}><ExplorerLink value={item.l1Tx} type="tx" chain="l1" />
          <span>L2 blocks {item.firstL2Block}–{item.lastL2Block}</span></div>)}
      </section>}
      <nav className={styles.tabs} aria-label="Trace views">{(["flow", "sequence", "raw"] as const).map(item =>
        <button key={item} className={"btn btn-sm " + (view === item ? "btn-solid" : "btn-outline")} aria-pressed={view === item} onClick={() => setView(item)}>
          {item === "flow" ? "Call flow" : item === "sequence" ? "Sequence" : "Decoded data"}</button>)}</nav>
      {view === "raw" ? <section className={styles.raw}><h2>Decoded flow model</h2><pre>{JSON.stringify(model, null, 2)}</pre></section>
        : <div className={styles.workspace}><TraceDiagram model={model} view={view} transaction={transaction} selected={selected} onSelect={setSelected} />
          <CallInspector node={selected === null ? undefined : model.nodes[selected]} /></div>}
    </>}
  </main>;
}
