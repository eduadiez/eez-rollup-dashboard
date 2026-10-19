import { useId } from "react";
import { formatUnits } from "viem";
import type { BridgeFeeState } from "../hooks/useBridge";
import styles from "./BridgeFeeQuote.module.css";

/** Rabby's Gas Price field maps to maxFeePerGas for EIP-1559 transactions. */
export function BridgeFeeQuote({ fees, sentToWallet = false, disabled = false, onRefresh }: {
  fees: BridgeFeeState;
  sentToWallet?: boolean;
  disabled?: boolean;
  onRefresh?: () => void;
}) {
  const id = useId();
  const transaction = fees.status === "ready" ? fees.quote?.transaction : null;
  const gasPrice = transaction?.gasPrice ?? transaction?.maxFeePerGas;
  const priorityFee = transaction?.maxPriorityFeePerGas;
  const message = fees.status === "error" ? `Fee quote unavailable: ${fees.errorMessage}` :
    fees.status === "expired" ? "Quote expired. Refresh fees before copying." :
    !transaction ? "Fetching fee quote…" :
    sentToWallet ? "Use these values for the transaction in your wallet." : "Updated again when you click Bridge.";

  return <section className={styles.panel} aria-label="Quoted bridge fees">
    <div className={styles.heading}>
      <span>{sentToWallet ? "Fees sent to wallet" : "Quoted fees"}</span>
      {onRefresh && <button type="button" onClick={onRefresh} disabled={disabled || fees.status === "loading"}
        className={styles.refresh}>Refresh fees</button>}
    </div>
    <div className={styles.field}>
      <label htmlFor={`${id}-price`}>Gas Price (Gwei)</label>
      <input id={`${id}-price`} readOnly value={gasPrice ? formatUnits(BigInt(gasPrice), 9) : ""}
        placeholder="—" onFocus={event => event.currentTarget.select()} />
    </div>
    <div className={styles.field}>
      <label htmlFor={`${id}-priority`}>Max Priority Fee (Gwei)</label>
      <input id={`${id}-priority`} readOnly value={priorityFee ? formatUnits(BigInt(priorityFee), 9) : ""}
        placeholder={transaction?.type === "0x0" ? "Not used for legacy transactions" : "—"}
        onFocus={event => event.currentTarget.select()} />
    </div>
    <p className={fees.status === "error" ? styles.error : styles.hint} role="status">{message}</p>
  </section>;
}
