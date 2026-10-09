import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { TxLink } from "./TxLink";
import styles from "./BridgeTransactionDialog.module.css";

let openDialogs = 0;
let previousBodyOverflow = "";

/** Shared modal presentation; closing it never cancels the underlying transaction. */
export function TransactionDialog({ open, complete, failed, title, description, hash, chain, onClose }: {
  open: boolean; complete: boolean; failed: boolean; title: string; description: string;
  hash: string | null; chain: "l1" | "l2"; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (openDialogs++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => { if (--openDialogs === 0) document.body.style.overflow = previousBodyOverflow; };
  }, [open]);

  return createPortal(<dialog ref={dialogRef} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, a[href]")];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <button className={styles.close} aria-label="Close transaction status" onClick={onClose}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
    <div className={styles.content}>
      {complete ? <svg className={styles.success} viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path d="m7 12 3 3 7-7" /></svg> :
        failed ? <span className={styles.failure} aria-hidden="true">!</span> : <span className={styles.spinner} aria-hidden="true" />}
      <h2 id={titleId} className={styles.title}>{title}</h2>
      <p id={descriptionId} className={styles.description} role={failed ? "alert" : "status"}>{description}</p>
      {hash && <TxLink hash={hash} chain={chain} className={styles.hash} />}
      {hash && <a className="btn btn-outline" href={`#/visualizer?mode=inspect&chain=${chain}&tx=${hash}`} onClick={onClose}>Follow this call →</a>}
      <button className={`btn ${complete || failed ? "btn-solid" : "btn-outline"}`} onClick={onClose}>{complete || failed ? "Done" : "Close"}</button>
    </div>
  </dialog>, document.body);
}
