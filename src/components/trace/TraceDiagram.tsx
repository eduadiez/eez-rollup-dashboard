import { useEffect, useMemo, useState } from "react";
import { traceRows } from "../../../trace-decoder/flow/rows.mjs";
import type { TraceModel, TraceNode } from "../../../trace-decoder/service/types";
import styles from "./TraceDetailView.module.css";

export const textValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "—";
const short = (value: string | null | undefined) => value ? value.slice(0, 10) + "…" + value.slice(-6) : "—";
function returnLabel(node: TraceNode): string {
  if (node.ret.reason) return node.ret.reason;
  if (node.ret.items?.length) return node.ret.items.map(item => textValue(item.value)).join(", ");
  if (node.ret.status === "void") return "No return value";
  if (node.ret.status === "unknown") return "Return not observed";
  return node.ret.status === "raw" ? "Raw return data" : node.ret.status;
}
export function TraceDiagram({ model, view, transaction, onSelect, selected }: {
  model: TraceModel; view: "flow" | "sequence"; transaction: string;
  onSelect: (id: number) => void; selected: number | null;
}) {
  const [protocol, setProtocol] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const rows = useMemo(() => traceRows(model, { transaction, protocol, search, collapsed }),
    [model, transaction, protocol, search, collapsed]);
  useEffect(() => { setPage(0); }, [transaction, protocol, search, collapsed, model]);
  const pages = Math.max(1, Math.ceil(rows.length / 100)), currentPage = Math.min(page, pages - 1);
  const visible = rows.slice(currentPage * 100, (currentPage + 1) * 100);
  const toggle = (id: number) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const card = (node: TraceNode, depth: number) => <div className={styles.callGroup} style={{ paddingInlineStart: Math.min(depth, 6) * 10 }}>
    {node.children.length > 0 && <button className={styles.fold} aria-expanded={!collapsed.has(node.id)}
      aria-label={(collapsed.has(node.id) ? "Expand " : "Collapse ") + node.contract + " " + node.fn}
      onClick={() => toggle(node.id)}>{collapsed.has(node.id) ? "+" : "−"}</button>}
    <button className={styles.call} data-chain={node.chain} data-selected={selected === node.id}
      data-failed={node.failed || node.reverted} data-ghost={node.kind === "ghost"} onClick={() => onSelect(node.id)}
      aria-pressed={selected === node.id}>
      <span className={styles.callTitle}><strong>{node.contract}</strong><span>{node.callType}</span></span>
      <code>{node.fn}</code>
      <span className={styles.muted}>{short(node.address)}{node.gasUsed ? " · " + node.gasUsed + " gas" : ""}</span>
      {(node.crossing || node.outgoing) && <span className={styles.crossingBadge}>
        {(node.crossing || node.outgoing)?.from} → {(node.crossing || node.outgoing)?.to} · {(node.crossing || node.outgoing)?.status}
      </span>}
      <span className={node.failed || node.reverted ? styles.failure : styles.returnValue}>↩ {returnLabel(node)}</span>
      {node.reverted && <span className={styles.failure}>Reverted context</span>}
      {node.kind === "ghost" && <span className={styles.warningText}>Remote execution not observed</span>}
    </button>
  </div>;
  return <section className={styles.diagram} aria-label={view === "flow" ? "Cross-chain call flow" : "Call sequence"}>
    <div className={styles.tools}>
      <label className={styles.search}>Find a call<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Contract, function, address…" /></label>
      <label className={styles.checkbox}><input type="checkbox" checked={protocol} onChange={event => setProtocol(event.target.checked)} />Show protocol calls</label>
      <button className="btn btn-sm btn-outline" onClick={() => setCollapsed(new Set())}>Expand all</button>
    </div>
    <p className={styles.muted}>Logical call order across both chains. Missing execution appears with a dashed border; settlement is shown separately.</p>
    {view === "flow" ? <div className={styles.flowScroller}>
      <div className={styles.flowHead}><strong>{model.chains.L1.name} · L1</strong><span>Calls</span><strong>{model.chains.L2.name} · L2</strong></div>
      {visible.map(({ node, depth, parent }) => {
        const parentNode = parent === null ? undefined : model.nodes[parent];
        const crossing = node.crossing;
        const crosses = !!crossing || !!parentNode && parentNode.chain !== node.chain;
        return <div className={styles.flowRow} key={node.id}>
          <div className={styles.lane}>{node.chain === "L1" && card(node, depth)}</div>
          <div className={styles.arrow} aria-label={crosses ? (crossing?.from || parentNode?.chain) + " to " + node.chain : undefined}>
            {crosses && <><span>{node.chain === "L2" ? "→" : "←"}</span><small>{crossing?.status || "Call"}</small></>}
          </div>
          <div className={styles.lane}>{node.chain === "L2" && card(node, depth)}</div>
        </div>;
      })}
    </div> : <div className={styles.tableScroll}><table className={styles.sequence}>
      <thead><tr><th>Step</th><th>Chain</th><th>Call</th><th>Return / status</th></tr></thead>
      <tbody>{visible.map(({ node }, index) => <tr key={node.id} data-selected={selected === node.id}>
        <td>{currentPage * 100 + index + 1}</td><td>{node.crossing ? node.crossing.from + " → " + node.chain : node.chain}</td>
        <td><button className={styles.textButton} onClick={() => onSelect(node.id)} aria-pressed={selected === node.id}>
          <strong>{node.contract}</strong><code>{node.fn}</code></button></td>
        <td className={node.failed || node.reverted ? styles.failure : undefined}>{returnLabel(node)}{node.kind === "ghost" && " · execution not observed"}</td>
      </tr>)}</tbody>
    </table></div>}
    {!rows.length && <p className={styles.empty}>No calls match this view. Enable protocol calls or clear the search to see more.</p>}
    <div className={styles.pagination}><span>{rows.length} calls · page {currentPage + 1} of {pages}</span>
      <button className="btn btn-sm btn-outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <button className="btn btn-sm btn-outline" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
  </section>;
}
