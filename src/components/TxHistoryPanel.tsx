import { useState, useEffect, useRef } from "react";
import type { TxRecord } from "../hooks/useTxHistory";
import { config } from "../config";
import { rpcCall } from "../rpc";
import type { Settlement } from "../lib/executionDebugger";
import { TxLink } from "./TxLink";
import styles from "./TxHistoryPanel.module.css";

interface Props {
  records: TxRecord[];
  onClear: () => void;
  onDebug?: (txHash: string) => void;
  onViewBlock?: (blockNumber: number) => void;
}

type BlockInfo = { l1?: number; l2?: number; chain: "l1" | "l2" };

const TYPE_LABELS: Record<TxRecord["type"], string> = {
  deploy: "Deploy",
  increment: "Increment",
  "cross-chain-proxy": "Create Proxy",
  "cross-chain-call": "Call",
  bridge: "Bridge",
  faucet: "Faucet",
};

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function StatusBadge({ status }: { status: TxRecord["status"] }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      {status === "pending" && <span className={styles.spinner} />}
      {status === "confirmed" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      )}
      {status === "failed" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      )}
      {status}
    </span>
  );
}

/** Older bridge records used the generic call type and encoded direction in the label. */
function isBridge(tx: TxRecord): boolean {
  return tx.type === "bridge" || tx.type === "cross-chain-call" && /^Bridge\s/.test(tx.label);
}

function directionOf(tx: TxRecord): TxRecord["direction"] {
  if (tx.direction) return tx.direction;
  if (isBridge(tx)) {
    if (/L2\s*→\s*L1/.test(tx.label)) return "l2-to-l1";
    if (/L1\s*→\s*L2/.test(tx.label)) return "l1-to-l2";
    return undefined;
  }
  return tx.type === "cross-chain-call" ? "l1-to-l2" : undefined;
}

function txChain(tx: TxRecord): "l1" | "l2" {
  return tx.type === "deploy" || tx.type === "increment" || directionOf(tx) === "l2-to-l1" ? "l2" : "l1";
}

function routeLabel(tx: TxRecord): string {
  const direction = directionOf(tx);
  if (direction) return direction === "l1-to-l2" ? "L1 → L2" : "L2 → L1";
  return isBridge(tx) ? "—" : tx.type === "cross-chain-proxy" ? "L1" : tx.type === "faucet" ? "—" : "L2";
}

/** Resolve the receipt on either chain, then use the node's exact settlement index. */
async function fetchBlockInfo(hash: string, preferred: "l1" | "l2"): Promise<BlockInfo | null> {
  for (const chain of [preferred, preferred === "l1" ? "l2" : "l1"] as const) {
    try {
      const receipt = await rpcCall(chain === "l1" ? config.l1Rpc : config.l2Rpc, "eth_getTransactionReceipt", [hash]) as { blockNumber: string; blockHash: string } | null;
      if (!receipt?.blockNumber) continue;
      const info: BlockInfo = { chain, [chain]: Number(BigInt(receipt.blockNumber)) };
      try {
        if (chain === "l2") {
          const settlement = await rpcCall(config.l2Rpc, "eez_getSettlementByL2Block", [receipt.blockHash]) as Settlement | null;
          if (settlement && settlement.canonicalL2 !== false) info.l1 = Number(BigInt(settlement.l1BlockNumber));
        } else {
          const ranges = await rpcCall(config.l2Rpc, "eez_getSettledL2RangesByL1Block", [receipt.blockHash]) as Settlement[];
          const first = ranges?.find(item => item.canonicalL2 !== false)?.l2Blocks[0];
          if (first) info.l2 = Number(BigInt(first.number));
        }
      } catch { /* The receipt remains useful without the settlement index. */ }
      return info;
    } catch { /* Try the other chain if the preferred RPC is unavailable. */ }
  }
  return null;
}

export function TxHistoryPanel({ records, onClear, onDebug, onViewBlock }: Props) {
  const [filter, setFilter] = useState<"all" | "bridge" | "calls">("all");
  // Lazily fetched block numbers keyed by tx hash
  const [blockCache, setBlockCache] = useState<Map<string, BlockInfo>>(
    () => new Map(),
  );
  const fetchingRef = useRef<Set<string>>(new Set());

  // Fetch block numbers for confirmed txs with hashes not yet cached
  useEffect(() => {
    for (const tx of records) {
      if (tx.status !== "confirmed" || !tx.hash) continue;
      if (blockCache.has(tx.hash) || fetchingRef.current.has(tx.hash)) continue;
      fetchingRef.current.add(tx.hash);

      const chain = txChain(tx);
      const hash = tx.hash;
      fetchBlockInfo(hash, chain).then((info) => {
        if (!info) return;
        setBlockCache((prev) => {
          const next = new Map(prev);
          next.set(hash, info);
          return next;
        });
      });
    }
  }, [records]); // eslint-disable-line react-hooks/exhaustive-deps

  if (records.length === 0) return null;

  const visibleRecords = records.filter(tx => filter === "all" || (filter === "bridge"
    ? isBridge(tx)
    : !isBridge(tx) && (tx.type === "cross-chain-call" || tx.type === "cross-chain-proxy" || tx.type === "increment")));

  return (
    <section className={styles.card} aria-label="Transaction history">
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Transaction History</h2>
        <div className={styles.headerRight}>
          <span className={styles.count}>{records.length} tx{records.length !== 1 ? "s" : ""}</span>
          <button className="btn btn-sm btn-outline" onClick={onClear}>Clear</button>
        </div>
      </div>
      <div className={styles.filters} role="group" aria-label="Filter transactions">
        {(["all", "bridge", "calls"] as const).map(value => <button key={value}
          className={`${styles.filter} ${filter === value ? styles.filterActive : ""}`}
          aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {value === "all" ? "All" : value === "bridge" ? "Bridge" : "Calls"}
        </button>)}
      </div>
      <div className={styles.columns} aria-hidden="true">
        <span>Action / details</span><span>Network</span><span>Transaction / blocks</span><span>Status</span><span>Time</span><span />
      </div>
      {visibleRecords.length === 0 ? <p className={styles.emptyState}>No {filter === "bridge" ? "bridge transfers" : "calls"} in your history yet.</p> : (
        <ol className={styles.list}>
          {visibleRecords.map(tx => {
            const info = tx.hash ? blockCache.get(tx.hash) : undefined;
            const bridge = isBridge(tx);
            const detail = bridge ? tx.label.replace(/^Bridge\s+/, "").replace(/\s+L[12]\s*→\s*L[12]$/, "") : tx.label;
            return (
              <li key={tx.id} className={styles.row}>
                <div className={styles.actionCol}>
                  <span className={styles.typeLabel}>{bridge ? "Bridge" : TYPE_LABELS[tx.type]}</span>
                  <span className={styles.detail} title={detail}>{detail}</span>
                </div>
                <div className={styles.routeCol}>{routeLabel(tx)}</div>
                <div className={styles.transactionCol}>
                  {tx.hash ? <TxLink hash={tx.hash} chain={info?.chain ?? txChain(tx)} className={styles.hash} /> : <span className={styles.noHash}>No transaction hash</span>}
                  {(info || tx.gasUsed) && <div className={styles.blockInfo}>
                    {info?.l1 != null && <span>L1 #{info.l1.toLocaleString()}</span>}
                    {info?.l2 != null && <span>L2 #{info.l2.toLocaleString()}</span>}
                    {tx.gasUsed && <span>{tx.gasUsed} gas</span>}
                  </div>}
                </div>
                <div className={styles.statusCol}><StatusBadge status={tx.status} /></div>
                <time className={styles.timeCol} dateTime={new Date(tx.timestamp).toISOString()} title={new Date(tx.timestamp).toLocaleString()}>{timeAgo(tx.timestamp)}</time>
                <div className={styles.actionsCol}>
                  {onViewBlock && info?.l1 != null && <button className={styles.explorerBtn}
                    onClick={() => onViewBlock(info.l1!)} title="View in Crosschain Explorer">Explorer</button>}
                  {onDebug && tx.hash && <button className={styles.explorerBtn}
                    onClick={() => onDebug(tx.hash!)} title="Debug in Visualizer">Debug</button>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
