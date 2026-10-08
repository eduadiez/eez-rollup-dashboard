import { useEffect, useRef, useState } from "react";
import type { CrossChainState, CrossChainPhase } from "../hooks/useCrossChain";
import { crossChainRoute } from "../hooks/useCrossChain";
import { config } from "../config";
import { TransactionDialog } from "./TransactionDialog";
import styles from "./BridgeTransactionDialog.module.css";

export function CrossChainTransactionDialog({ state, onDismiss }: { state: CrossChainState; onDismiss: () => void }) {
  const [transaction, setTransaction] = useState<CrossChainState | null>(null);
  const [open, setOpen] = useState(false);
  const previousPhase = useRef<CrossChainPhase>("idle");
  const { phase, direction, txHash, error, calldata, proxyAddress, targetAddress } = state;
  useEffect(() => {
    const previous = previousPhase.current;
    previousPhase.current = phase;
    if (phase === "idle") return;
    setTransaction({ phase, direction, txHash, error, calldata, proxyAddress, targetAddress });
    if (previous === "idle" || (phase === "creating-proxy" || phase === "sending") && previous !== phase ||
      (phase === "confirmed" || phase === "failed") && previous !== phase) setOpen(true);
  }, [phase, direction, txHash, error, calldata, proxyAddress, targetAddress]);

  if (!transaction) return null;
  const complete = transaction.phase === "confirmed", failed = transaction.phase === "failed";
  const signing = transaction.phase === "creating-proxy" || transaction.phase === "sending";
  const creation = !transaction.calldata;
  const chain = crossChainRoute(transaction.direction).source;
  const network = chain === "l1" ? config.l1NetworkName : config.rollupName;
  const action = creation ? "proxy creation" : "cross-chain call";
  const title = failed ? creation ? "Proxy creation failed" : "Cross-chain call failed" :
    complete ? creation ? transaction.txHash ? "Proxy created" : "Proxy available" : "Cross-chain call confirmed" :
    signing ? "Confirm in your wallet" : "Waiting for confirmation";
  const description = failed ? transaction.error || "The transaction could not be completed." :
    complete ? creation ? transaction.txHash ? `Proxy created on ${network}.` : `This proxy is already deployed on ${network}.` : `Cross-chain call confirmed on ${network}.` :
    signing ? `Review the ${action} in your wallet on ${network}.` : `Your ${action} is pending on ${network}.`;
  const close = () => { setOpen(false); if (complete || failed) onDismiss(); };
  return <>
    {!open && !complete && !failed && phase !== "idle" && <button className={styles.reopen} onClick={() => setOpen(true)}>View transaction</button>}
    <TransactionDialog open={open} complete={complete} failed={failed} title={title} description={description}
      hash={transaction.txHash} chain={chain} onClose={close} />
  </>;
}
