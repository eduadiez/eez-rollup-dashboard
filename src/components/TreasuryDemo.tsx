import { TreasurySourceVerification } from "./TreasurySourceVerification";
import { useEffect, useMemo, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { TreasuryFaucet } from "./TreasuryFaucet";
import { TreasuryMainnetSetup } from "./TreasuryMainnetSetup";
import { isMainnetSetupTarget, loadMainnetManifest, mainnetSetupKey, mainnetManifestKey } from "../lib/treasury/mainnetSetup";
import { TreasurySetup } from "./TreasurySetup";
import { TreasuryTransactionHistory } from "./TreasuryTransactionHistory";
import { isSharedTarget } from "../lib/treasury/deployment";
import { loadActiveManifest, setupStorageKeys, withActiveTreasury } from "../lib/treasury/setupState";
import { TreasuryRestart } from "./TreasuryRestart";
import { parseTreasuryConfig, requireDashboardTreasury } from "../lib/treasury/client";
import { TreasuryConnected } from "./TreasuryConnected";
import type { TreasuryWallet } from "./TreasuryConnected";
import styles from "./TreasuryDemo.module.css";

/** Deployment bindings are checked before exposing signing or payment controls. */
function TreasuryDemoView({ wallet, ready }: { wallet: TreasuryWallet; ready: boolean }) {
  const [owners, setOwners] = useState(false);
  const [faucet, setFaucet] = useState(false);
  const [revision, setRevision] = useState(0);
  const refreshSelection = () => { setRevision(value => value + 1); setOwners(false); setFaucet(false); };
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === null || [...setupStorageKeys, mainnetSetupKey, mainnetManifestKey].includes(event.key) || event.key?.includes(":policy-upgrade:")) refreshSelection(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const shared = ready && isSharedTarget(L1_CHAIN.chainId, L2_CHAIN.chainId, config.rollupsAddress, config.ccmL2Address);
  const mainnet = ready && isMainnetSetupTarget(L1_CHAIN.chainId, L2_CHAIN.chainId, config.rollupsAddress, config.ccmL2Address, config.l1Bridge, config.l2Bridge);
  const target = useMemo(() => ({ l1: { rpc: config.l1Rpc, front: config.l1ProxyRpc, explorer: config.l1Explorer }, l2: { rpc: config.l2Rpc, front: config.l2ProxyRpc, explorer: config.l2Explorer },
    fees: { l1: config.l1FeeMaxTotalWei, l2: config.l2FeeMaxTotalWei } }), [ready]);
  const parsed = useMemo(() => {
    if (!ready) return { deployment: null, error: "" };
    try {
      const value = config.treasury ?? (mainnet ? loadMainnetManifest(localStorage) : shared ? loadActiveManifest(localStorage) : null);
      if (!value) return { deployment: null, error: "" };
      const deployment = parseTreasuryConfig(value);
      requireDashboardTreasury(deployment, { l1ChainId: L1_CHAIN.chainId, l2ChainId: L2_CHAIN.chainId,
        l1Rpc: config.l1Rpc, l2Rpc: config.l2Rpc, l2Front: config.l2ProxyRpc, l1Front: config.l1ProxyRpc,
        registry: config.rollupsAddress, manager: config.ccmL2Address, feesEnabled: config.l2FeesEnabled, maxTotalWei: config.l2FeeMaxTotalWei, l1FeesEnabled: config.l1FeesEnabled, l1MaxTotalWei: config.l1FeeMaxTotalWei });
      return { deployment, error: "" };
    }
    catch (error) { return { deployment: null, error: (error as Error).message }; }
  }, [ready, revision, shared, mainnet]);
  if (!ready) return <p role="status">Loading treasury configuration…</p>;
  if (parsed.error) return <p role="alert">Treasury connection unavailable: {parsed.error}</p>;
  const managed = shared && !config.treasury && config.l1FeesEnabled && config.l2FeesEnabled;
  const faucetAvailable = managed && BigInt(L1_CHAIN.chainId) === 10200n && parsed.deployment?.environment === "dashboard-testnet";
  if (faucetAvailable && faucet && parsed.deployment) return <TreasuryFaucet wallet={wallet} target={target} onBack={() => setFaucet(false)} />;
  const transactions = managed ? <TreasuryTransactionHistory key={revision} target={target} /> : null;
  const restart = managed ? <TreasuryRestart wallet={wallet} onRestart={refreshSelection} /> : null;
  if (!parsed.deployment && mainnet && !config.treasury) return <TreasuryMainnetSetup wallet={wallet} target={target} onComplete={refreshSelection} />;
  if (!parsed.deployment) return managed
    ? <div className={styles.treasury}><TreasurySetup key={revision} wallet={wallet} target={target} onComplete={refreshSelection} />{transactions}{restart}</div> : <p role="status">Connect a configured treasury for this network.</p>;
  const instance = parsed.deployment.instance;
  return <div className={styles.treasury}>
    <div className={styles.modeNav} aria-label="Treasury example mode">
      {parsed.deployment.payments && <button className="btn btn-outline" aria-pressed={!owners} onClick={() => { setOwners(false); }}>Payments</button>}
      {parsed.deployment.action && <button className="btn btn-outline" aria-pressed={(owners || !parsed.deployment.payments)} onClick={() => { setOwners(true); }}>Owner demo</button>}
      {faucetAvailable && <button className="btn btn-ghost" onClick={() => setFaucet(true)}>Get Test USDC</button>}
    </div>
    <TreasuryConnected key={`${parsed.deployment.instance}-${parsed.deployment.payments?.policy}-${owners}`} deployment={parsed.deployment} wallet={wallet} payments={!!parsed.deployment.payments && !owners} guardAction={mainnet && !config.treasury ? async action => {
      await navigator.locks.request(mainnetSetupKey, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another treasury action is running");
        const current = loadMainnetManifest(localStorage);
        if (current?.instance !== instance || current.payments?.policy !== parsed.deployment!.payments?.policy) throw new Error("The selected treasury changed. Reload before continuing");
        await action();
      });
    } : managed ? action => withActiveTreasury(localStorage, navigator.locks, instance, action, parsed.deployment!.payments?.policy) : undefined} />
    {restart}
  </div>;
}

export function TreasuryDemo(props: { wallet: TreasuryWallet; ready: boolean }) {
  return <><TreasuryDemoView {...props} />{props.ready && <TreasurySourceVerification />}</>;
}
