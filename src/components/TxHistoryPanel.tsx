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
  "cross-chain-call": "Cross-Chain",
  faucet: "Faucet",
};

const TYPE_COLORS: Record<TxRecord["type"], string> = {
  deploy: "var(--accent-light)",
  increment: "var(--green)",
  "cross-chain-proxy": "var(--yellow)",
  "cross-chain-call": "var(--accent)",
  faucet: "var(--cyan)",
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

/** Determine which chain a tx lives on based on its type */
function txChain(type: TxRecord["type"]): "l1" | "l2" {
  return type === "deploy" || type === "increment" ? "l2" : "l1";
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

      const chain = txChain(tx.type);
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

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Transaction History</span>
        <div className={styles.headerRight}>
          <span className={styles.count}>{records.length} tx{records.length !== 1 ? "s" : ""}</span>
          <button className="btn btn-sm btn-outline" onClick={onClear}>Clear</button>
        </div>
      </div>

      <div className={styles.list}>
        {records.map((tx) => {
          const info = tx.hash ? blockCache.get(tx.hash) : undefined;
          return (
            <div key={tx.id} className={styles.row}>
              <div className={styles.typeCol}>
                <span
                  className={styles.typeDot}
                  style={{ background: TYPE_COLORS[tx.type] }}
                />
                <span className={styles.typeLabel}>{TYPE_LABELS[tx.type]}</span>
              </div>

              <div className={styles.labelCol}>{tx.label}</div>

              <div className={styles.hashCol}>
                {tx.hash ? (
                  <TxLink
                    hash={tx.hash}
                    chain={info?.chain ?? txChain(tx.type)}
                    className={styles.hash}
                  />
                ) : (
                  <span className={styles.noHash}>&mdash;</span>
                )}
              </div>

              <div className={styles.blockCol}>
                <span className={styles.blockLabel}>L1</span>
                <span className={styles.blockNum}>
                  {info?.l1 != null ? info.l1.toLocaleString() : "\u2014"}
                </span>
              </div>

              <div className={styles.blockCol}>
                <span className={styles.blockLabel}>L2</span>
                <span className={styles.blockNum}>
                  {info?.l2 != null ? info.l2.toLocaleString() : "\u2014"}
                </span>
              </div>

              <div className={styles.gasCol}>
                {tx.gasUsed ? (
                  <span className={styles.gas}>{tx.gasUsed}</span>
                ) : null}
              </div>

              <div className={styles.statusCol}>
                <StatusBadge status={tx.status} />
              </div>

              <div className={styles.timeCol}>
                <span className={styles.time}>{timeAgo(tx.timestamp)}</span>
              </div>

              <div className={styles.actionsCol}>
                {onViewBlock && info?.l1 != null && (
                  <button
                    className={styles.explorerBtn}
                    onClick={() => onViewBlock(info.l1!)}
                    title="View in Crosschain Explorer"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                    Explorer
                  </button>
                )}
                {onDebug && tx.hash && (
                  <button
                    className="btn btn-sm btn-yellow btn-tint"
                    onClick={() => onDebug(tx.hash!)}
                    title="Debug in Visualizer"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    Debug
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
