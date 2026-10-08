import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BridgeState, BridgePhase } from "../hooks/useBridge";
import { config } from "../config";
import { TxLink } from "./TxLink";
import styles from "./BridgeTransactionDialog.module.css";

type Transaction = { phase: BridgePhase; hash: string | null; chain: "l1" | "l2"; approval: boolean; error: string | null };

/** Dismissing pending status hides the popup without cancelling receipt polling. */
export function BridgeTransactionDialog({ state, onDismiss }: { state: BridgeState; onDismiss: () => void }) {
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [open, setOpen] = useState(false);
  const previousPhase = useRef<BridgePhase>("idle");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { phase, txHash, direction, error } = state;

  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (phase === "idle") {
      // Approval receipts return the form to idle; retain their hash for the success popup.
      if (previous === "approve-pending") {
        setTransaction(current => current ? { ...current, phase: "confirmed" } : null);
        setOpen(true);
      }
      return;
    }
    setTransaction(() => ({ phase, hash: txHash, chain: direction === "l1-to-l2" ? "l1" : "l2",
      approval: phase === "approving" || phase === "approve-pending" || phase === "failed" && (previous === "approving" || previous === "approve-pending"),
      error }));
    if (previous === "idle" || phase === "sending" || phase === "approving" ||
        (phase === "confirmed" || phase === "failed") && previous !== phase) setOpen(true);
  }, [phase, txHash, direction, error]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open, transaction]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!transaction) return null;
  const complete = transaction.phase === "confirmed";
  const failed = transaction.phase === "failed";
  const signing = transaction.phase === "sending" || transaction.phase === "approving";
  const network = transaction.chain === "l1" ? config.l1NetworkName : config.rollupName;
  const title = failed ? transaction.approval ? "Approval failed" : "Bridge transaction failed" :
    complete ? transaction.approval ? "Approval confirmed" : "Bridge transaction confirmed" :
    signing ? "Confirm in your wallet" : "Waiting for confirmation";
  const description = failed ? transaction.error || "The transaction could not be completed." :
    complete ? transaction.approval ? "Token spending approved. You can now bridge your tokens." : `Transaction confirmed on ${network}.` :
    signing ? `Review the ${transaction.approval ? "approval" : "bridge transaction"} in your wallet.` :
    `Your ${transaction.approval ? "approval" : "bridge transaction"} is pending on ${network}.`;
  const close = () => {
    setOpen(false);
    if (complete || failed) onDismiss();
  };

  return <>
    {!open && !complete && !failed && phase !== "idle" && <button className={styles.reopen} onClick={() => setOpen(true)}>View transaction</button>}
    {createPortal(<dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, a[href]")];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <button className={styles.close} aria-label="Close transaction status" onClick={close}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <div className={styles.content}>
        {complete ? <svg className={styles.success} viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path d="m7 12 3 3 7-7" /></svg> :
          failed ? <span className={styles.failure} aria-hidden="true">!</span> : <span className={styles.spinner} aria-hidden="true" />}
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p id={descriptionId} className={styles.description} role={failed ? "alert" : "status"}>{description}</p>
        {transaction.hash && <TxLink hash={transaction.hash} chain={transaction.chain} className={styles.hash} />}
        <button className={`btn ${complete || failed ? "btn-solid" : "btn-outline"}`} onClick={close}>{complete || failed ? "Done" : "Close"}</button>
      </div>
    </dialog>, document.body)}
  </>;
}
