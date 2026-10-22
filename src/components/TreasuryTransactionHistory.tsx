import { loadTreasuryArtifacts } from "../lib/treasury/release";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { loadDeployment, TreasuryDeployment } from "../lib/treasury/deployment";
import type { Chain, DeploymentTarget } from "../lib/treasury/deployment";
import { loadActiveManifest, policyUpgradeKey } from "../lib/treasury/setupState";
import { readUpgrade, upgradeTransactions } from "../lib/treasury/upgrade";
import { observeSetupTransaction, setupTransactions } from "../lib/treasury/setupTransactions";
import type { SetupObservation, SetupTransaction } from "../lib/treasury/setupTransactions";
import { ExplorerLink } from "./ExplorerLink";
import { NetworkIcon } from "./NetworkIcon";
import styles from "./TxHistoryPanel.module.css";
import layout from "./TreasuryTransactionHistory.module.css";

type Row = SetupTransaction & { observation?: SetupObservation; finalized?: boolean };
const labels = { pending: "Pending", included: "Included", failed: "Failed", rechecking: "Rechecking", unavailable: "Unavailable" };

/** Read-only history follows the selected journal across setup and the connected
 * treasury. Neither a displayed receipt nor finality advances the setup journal.
 */
export function TreasuryTransactionHistory({ target }: { target: DeploymentTarget }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const state = loadDeployment(localStorage), d = new TreasuryDeployment(target, await loadTreasuryArtifacts(state));
        if (!alive) return;
        const manifest = loadActiveManifest(localStorage);
        const upgradeRaw = manifest ? localStorage.getItem(policyUpgradeKey(manifest.instance)) : null;
        const upgrade = manifest ? readUpgrade(upgradeRaw, manifest) : null;
        const upgrades = upgrade ? [...(upgrade.previousUpgrade ? [upgrade.previousUpgrade] : []), upgrade] : [];
        const records = [...(state ? setupTransactions(d, state) : []), ...upgrades.flatMap(record =>
          upgradeTransactions(record)
            .map(row => ({ ...row, id: `${record.state.salt}:${row.id}` })))];
        const identity = JSON.stringify(state);
        const current = () => alive && JSON.stringify(loadDeployment(localStorage)) === identity
          && (!manifest || localStorage.getItem(policyUpgradeKey(manifest.instance)) === upgradeRaw);
        setRows(previous => records.map(record => ({ ...previous.find(row => row.id === record.id && row.hash === record.hash), ...record })));
        const observed: Row[] = [];
        for (let offset = 0; alive && offset < records.length; offset += 4) {
          observed.push(...await Promise.all(records.slice(offset, offset + 4).map(async record => ({ ...record, observation: await observeSetupTransaction(d, record) }))));
        }
        if (!current()) return;
        setRows(observed); setError("");
        // Finality enriches already displayed inclusion. It never gates the next
        // setup transaction and an unavailable finalized head leaves Included.
        const chains = [...new Set(records.map(record => record.chain))];
        const finalized: Partial<Record<Chain, bigint>> = {};
        await Promise.allSettled(chains.map(async chain => {
          const block = await d.rpc<{ number: Hex; hash: Hex } | null>(chain, "eth_getBlockByNumber", ["finalized", false]);
          if (block && /^0x[\da-f]+$/i.test(block.number) && /^0x[\da-f]{64}$/i.test(block.hash)) finalized[chain] = BigInt(block.number);
        }));
        if (current()) setRows(observed.map(row => ({ ...row, finalized: row.observation?.status === "included"
          && finalized[row.chain] !== undefined && BigInt(row.observation.blockNumber!) <= finalized[row.chain]! })));
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (alive) timer = setTimeout(refresh, 4000); }
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [target]);
  if (!rows.length && !error) return null;
  return <section className={styles.card} aria-label="Transaction history">
    <div className={styles.cardHeader}><div><h2 className={styles.cardTitle}>Transaction History</h2><p className={styles.noHash}>Oldest first</p></div>
      <span className={styles.count}>{rows.length} tx{rows.length !== 1 ? "s" : ""}</span></div>
    {error && <p className={styles.lookupError} role="alert">{error}</p>}
    <div className={`${styles.columns} ${layout.columns}`} aria-hidden="true"><span>Action</span><span>Network</span><span>Transaction</span><span>Block</span><span>Status</span><span>Time</span></div>
    <ol className={styles.list}>{rows.map((row, index) => {
      const observation = row.observation;
      const label = row.finalized ? "Finalized" : observation ? labels[observation.status] : "Checking";
      const status = observation?.status === "included" ? "confirmed" : observation?.status === "failed" ? "failed" : "pending";
      return <li key={row.id} className={`${styles.row} ${layout.row}`} data-tx-hash={row.hash} data-status={label.toLowerCase()}>
        <div className={styles.actionCol}><span className={styles.typeLabel}>Step {index + 1}</span><span className={`${styles.detail} ${layout.detail}`} title={row.label}>{row.label}</span></div>
        <div className={styles.routeCol}><NetworkIcon chain={row.chain} decorative /><span>{row.chain === "l1" ? "Chiado" : "EEZ-X"}</span></div>
        <div className={styles.transactionCol}>{row.hash ? <ExplorerLink value={row.hash} type="tx" chain={row.chain} className={styles.hash} /> : <span className={styles.noHash}>Awaiting wallet</span>}</div>
        <div className={styles.blockCol}>{observation?.blockNumber ? <ExplorerLink value={String(BigInt(observation.blockNumber))} type="block" chain={row.chain} label={`#${BigInt(observation.blockNumber).toLocaleString()}`} /> : <span className={styles.noHash}>—</span>}</div>
        <div className={styles.statusCol}><span className={`${styles.badge} ${styles[status]}`} title={observation?.detail ?? (row.finalized ? `Finalized on ${row.chain.toUpperCase()}.` : observation?.status === "included" ? "Included on its source chain; finality has not yet been established." : undefined)}>{label}</span></div>
        {observation?.timestamp !== undefined ? <time className={styles.timeCol} dateTime={new Date(observation.timestamp).toISOString()} title={new Date(observation.timestamp).toLocaleString()}>{new Date(observation.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> : <span className={styles.timeCol}>—</span>}
      </li>;
    })}</ol>
  </section>;
}
