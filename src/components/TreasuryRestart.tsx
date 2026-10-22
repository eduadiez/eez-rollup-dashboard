import { useEffect, useRef, useState } from "react";
import { sharedDeploymentKey } from "../lib/treasury/deployment";
import { restartSetup, setupSnapshot } from "../lib/treasury/setupState";
import type { SetupSnapshot } from "../lib/treasury/setupState";
import type { TreasuryWallet } from "./TreasuryConnected";
import styles from "./TreasuryDemo.module.css";

export function TreasuryRestart({ wallet, onRestart }: { wallet: TreasuryWallet; onRestart: () => void }) {
  const [snapshot, setSnapshot] = useState<SetupSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    const refresh = () => {
      if (active.current) return;
      try { setSnapshot(setupSnapshot(localStorage)); }
      catch (failure) { setSnapshot(null); setError(String(failure)); }
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    window.addEventListener("storage", refresh);
    return () => { clearInterval(timer); window.removeEventListener("storage", refresh); };
  }, []);
  const restart = async () => {
    if (active.current || !snapshot) return;
    active.current = true; setBusy(true); setError("");
    try {
      if (!navigator.locks) throw new Error("Starting a new treasury requires browser Web Locks support");
      await navigator.locks.request(sharedDeploymentKey, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another treasury action is running. Wait for it to finish");
        restartSetup(localStorage, snapshot);
        setSnapshot(setupSnapshot(localStorage));
        onRestart();
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { active.current = false; setBusy(false); }
  };
  // Before deployment starts, Change setup already returns to the same chooser.
  if (!snapshot?.state?.completed.length && !snapshot?.manifest && !error) return null;
  return <section className={styles.setupActions} aria-label="Treasury setup management">
    <button className="btn btn-outline" disabled={busy || !snapshot || !wallet.address || !wallet.provider || !!snapshot.blocked} onClick={() => void restart()}>
      {busy ? "Starting new treasury…" : "Start new treasury"}
    </button>
    {!wallet.address && <p>Connect a wallet to start a new treasury.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
