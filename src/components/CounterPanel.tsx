import { useEffect, useRef, useState } from "react";
import { config } from "../config";
import type { CounterChain, TxStatus } from "../hooks/useCounter";
import { ExplorerLink } from "./ExplorerLink";
import { NetworkIcon } from "./NetworkIcon";
import { TransactionDialog } from "./TransactionDialog";
import styles from "./CounterPanel.module.css";

interface Props {
  chain: CounterChain; onChainChange: (chain: CounterChain) => void;
  address: string; onAddressChange: (address: string) => void;
  count: bigint | null; prevCount: bigint | null; readError: string | null;
  txStatus: TxStatus; busy: boolean; walletConnected: boolean;
  onDeploy: () => void; onIncrement: () => void; onRefresh: () => void; onReset: () => void;
}

export function CounterPanel({ chain, onChainChange, address, onAddressChange, count, prevCount,
  readError, txStatus, busy, walletConnected, onDeploy, onIncrement, onRefresh, onReset }: Props) {
  const validAddress = /^0x[0-9a-f]{40}$/i.test(address);
  const network = chain === "l1" ? config.l1NetworkName : config.rollupName;
  const [open, setOpen] = useState(false), [transaction, setTransaction] = useState<TxStatus | null>(null);
  const previousPhase = useRef<TxStatus["phase"]>("idle");
  useEffect(() => {
    const previous = previousPhase.current; previousPhase.current = txStatus.phase;
    if (txStatus.phase === "idle") return;
    setTransaction(txStatus);
    if (previous === "idle" || txStatus.phase === "sending" && previous !== "sending" ||
      (txStatus.phase === "confirmed" || txStatus.phase === "failed") && previous !== txStatus.phase) setOpen(true);
  }, [txStatus]);
  const complete = transaction?.phase === "confirmed", failed = transaction?.phase === "failed";
  const deploy = transaction?.action === "deploy";
  const close = () => { setOpen(false); if (complete || failed) onReset(); };
  const delta = count !== null && prevCount !== null ? count - prevCount : 0n;

  return <section className={styles.card} aria-label="Counter demo">
    <div className={styles.header}><h2>Counter Demo</h2><p>Deploy or select a counter, then control it from the other network.</p></div>
    <fieldset className={styles.networkFields} disabled={busy}>
      <legend className={styles.label}>Counter network</legend>
      <div className={styles.networkSelector}>{(["l1", "l2"] as const).map(side => <button key={side}
        className={`btn ${chain === side ? "btn-solid" : "btn-outline"}`} aria-pressed={chain === side}
        onClick={() => onChainChange(side)}><NetworkIcon chain={side} decorative />{side === "l1" ? config.l1NetworkName : config.rollupName}</button>)}</div>
    </fieldset>
    <div className={styles.display} role="group" aria-label={`Counter value on ${network}`}>
      <span className={styles.number}>{count === null ? "—" : count.toLocaleString()}</span>
      <span className={styles.label}>Current count</span>
      {delta !== 0n && <span className={styles.delta}>{delta > 0n ? "+" : ""}{delta.toLocaleString()}</span>}
    </div>
    <label className={styles.label} htmlFor="counter-address">Counter address on {network}</label>
    <input id="counter-address" className={styles.input} value={address} spellCheck={false} autoComplete="off" disabled={busy}
      onChange={event => onAddressChange(event.target.value)} placeholder="0x... existing counter address" />
    {validAddress && <div className={styles.addressRow}><ExplorerLink value={address} chain={chain} /><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onAddressChange("")}>Clear</button></div>}
    {address && !validAddress && <p className={styles.error} role="alert">Enter a valid counter address</p>}
    {readError && <p className={styles.error} role="alert">{readError}</p>}
    <div className={styles.actions}>
      {validAddress && <button className="btn btn-solid" disabled={busy || !walletConnected || count === null} onClick={onIncrement}>Increment (+1)</button>}
      <button className={`btn ${validAddress ? "btn-outline" : "btn-solid"}`} disabled={busy || !walletConnected} onClick={onDeploy}>{validAddress ? "Deploy new counter" : "Deploy counter"}</button>
      {validAddress && <button className="btn btn-outline" disabled={busy} onClick={onRefresh}>Refresh</button>}
    </div>
    <p className={styles.hint}>{validAddress ? `Increment here on ${network}, or use Cross-Chain Calls to increment from the other network.` : `Deploy a SimpleCounter on ${network} or paste an existing counter address.`}</p>
    {!walletConnected && <p className={styles.hint}>Connect your wallet to deploy or increment a counter.</p>}
    {transaction && <>
      {!open && !complete && !failed && txStatus.phase !== "idle" && <button className="btn btn-outline" onClick={() => setOpen(true)}>View transaction</button>}
      <TransactionDialog open={open} complete={!!complete} failed={!!failed} chain={chain} hash={transaction.hash} onClose={close}
        title={failed ? "Counter transaction failed" : complete ? deploy ? "Counter deployed" : "Counter incremented" : transaction.phase === "sending" ? "Confirm in your wallet" : "Waiting for confirmation"}
        description={failed ? transaction.error || "The transaction could not be completed." : complete ? `Counter ${deploy ? "deployed" : "incremented"} on ${network}.` : transaction.phase === "sending" ? `Review the counter ${deploy ? "deployment" : "increment"} in your wallet on ${network}.` : `Your counter transaction is pending on ${network}.`} />
    </>}
  </section>;
}
