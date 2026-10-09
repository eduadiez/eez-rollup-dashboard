import { useEffect, useState } from "react";
import { fetchCallSettlement, type CallSettlement } from "../../lib/callSettlement";
import type { DebugTransaction } from "../../lib/executionDebugger";
import { quantity } from "../../lib/executionDebugger";
import { ExplorerLink } from "../ExplorerLink";
import { TxLink } from "../TxLink";
import styles from "./ExecutionDebugger.module.css";

export function SettlementProgress({ transaction, onCounterpart }: { transaction: DebugTransaction; onCounterpart: (hash: string) => void }) {
  const [progress, setProgress] = useState<CallSettlement | null>(null);
  const crossChain = transaction.chain === "l2" || !transaction.receipt || transaction.payload?.method === "postAndVerifyBatch" || transaction.events.some(event => event.protocol && (/CrossChain/.test(event.name) || event.name === "BatchPosted"));
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setProgress(null);
    const poll = async () => {
      try {
        const result = await fetchCallSettlement(transaction.tx.hash, transaction.chain, crossChain);
        if (!stopped) setProgress(result);
      } catch (error) {
        if (!stopped) setProgress({ state: "unavailable", execution: "unverified", counterpartHashes: [], message: `Settlement evidence unavailable: ${(error as Error).message}` });
      }
      if (!stopped) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [transaction.tx.hash, transaction.chain, crossChain, transaction.receipt?.status]);
  const stages = ["pending", "posted", "safe", "finalized"];
  const current = stages.indexOf(progress?.state === "awaiting" ? "pending" : progress?.state ?? "pending");
  return <section className={styles.settlementProgress} aria-label="Call settlement progress">
    <div className={styles.cardHeader}><h2>{progress?.localL1 ? "L1 confirmation" : "Follow this call"}</h2><span className={progress?.execution === "reverted" ? styles.failed : undefined}>Source execution: {progress?.execution ?? "checking"}</span></div>
    <ol className={styles.progressStages} aria-label="Settlement stages">{stages.map((stage, index) => <li key={stage} data-reached={index > 0 && current >= index} aria-current={current === index ? "step" : undefined}>{stage === "pending" ? "Pending" : stage === "posted" ? progress?.localL1 ? "Included on L1" : "Posted on L1" : stage === "safe" ? "Safe" : "Finalized"}</li>)}</ol>
    <p role="status" className={progress?.state === "reorg" || progress?.state === "unavailable" ? styles.warning : styles.muted}>{progress?.message ?? "Checking canonical inclusion and settlement…"}</p>
    {progress?.settlement && !["reorg", "unavailable"].includes(progress.state) && <div className={styles.settlementLinks}>
      <ExplorerLink chain="l1" type="block" value={BigInt(progress.settlement.l1BlockNumber).toString()} label={`L1 #${quantity(progress.settlement.l1BlockNumber)}`} />
      <TxLink chain="l1" hash={progress.settlement.l1TransactionHash} />
      <a href={`/monitor/?settlement=${progress.settlement.l1TransactionHash}#settlement-record`}>View settlement in Monitor →</a>
    </div>}
    {!!progress?.counterpartHashes.length && <div className={styles.settlementLinks}><span>L2 execution:</span>{progress.counterpartHashes.map(hash => <button key={hash} className="btn btn-outline" onClick={() => onCounterpart(hash)}>Inspect {hash.slice(0, 10)}…{hash.slice(-6)} →</button>)}</div>}
  </section>;
}
