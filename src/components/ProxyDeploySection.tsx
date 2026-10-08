import { useState, useEffect, useRef } from "react";
import { crossChainRoute, type CrossChainState, type CrossChainDirection } from "../hooks/useCrossChain";
import { useBlockscoutAbi } from "../hooks/useBlockscoutAbi";
import { config } from "../config";
import { rpcCall } from "../rpc";
import { TxLink } from "./TxLink";
import { ExplorerLink } from "./ExplorerLink";
import { NetworkIcon } from "./NetworkIcon";
import { lookupAddressForChain } from "../lib/addressBook";
import styles from "./ProxyDeploySection.module.css";

interface Props {
  embedded?: boolean;
  state: CrossChainState;
  direction?: CrossChainDirection;
  onDirectionChange?: (direction: CrossChainDirection) => void;
  onSelectProxy?: (target: string, direction: CrossChainDirection) => void;
  targetAddress: string;
  onTargetChange: (addr: string) => void;
  contractName: string | null;
  recentAddresses: string[];
  savedProxies: Record<string, string>;
  savedL2Proxies?: Record<string, string>;
  onCreateProxy: (target: string, direction?: CrossChainDirection) => void;
  getProxy: (target: string, direction?: CrossChainDirection) => string | null;
  onReset: () => void;
  computeProxyAddress: (target: string, direction?: CrossChainDirection) => Promise<string | null>;
  onProxyDetected: (proxy: string | null, target: string, direction: CrossChainDirection) => void;
  selecting?: boolean;
}

function ProxyRow({ target, proxy, direction, selected, disabled, onSelect }: {
  target: string; proxy: string; direction: CrossChainDirection; selected: boolean; disabled: boolean; onSelect: () => void;
}) {
  const route = crossChainRoute(direction);
  const { contractName } = useBlockscoutAbi(target, route.destination);
  return <tr className={`${styles.row} ${selected ? styles.selectedRow : ""}`}>
    <td className={styles.td}><ExplorerLink value={target} chain={route.destination} label={contractName || undefined} className={styles.addrLink} /></td>
    <td className={styles.td}><ExplorerLink value={proxy} chain={route.source} label={contractName ? `${contractName} proxy` : undefined} className={styles.addrLink} /></td>
    <td className={styles.tdNarrow}><div className={styles.route} role="group" aria-label={direction === "l1-to-l2" ? "L1 → L2" : "L2 → L1"}>
      <NetworkIcon chain={route.source} /><span aria-hidden="true">→</span><NetworkIcon chain={route.destination} />
    </div></td>
    <td className={styles.tdNarrow}><button className={styles.callBtn} disabled={disabled} onClick={onSelect} aria-pressed={selected}
      title={`Saved in this browser. Selecting checks the registry address and deployed code on ${route.source === "l1" ? config.l1NetworkName : config.rollupName}.`}
      aria-label={`${selected ? "Selected proxy" : "Select proxy"} for ${target} on ${route.source.toUpperCase()}`}>{selected ? "Selected" : "Select"}</button></td>
  </tr>;
}

export function ProxyDeploySection({ embedded = false, state, direction = "l1-to-l2", onDirectionChange, onSelectProxy,
  targetAddress, onTargetChange, contractName, recentAddresses, savedProxies, savedL2Proxies = {},
  onCreateProxy, getProxy, onReset, computeProxyAddress, onProxyDetected, selecting = false }: Props) {
  const [showRecent, setShowRecent] = useState(false);
  const [detected, setDetected] = useState<{ proxy: string; target: string; direction: CrossChainDirection } | null>(null);
  const [checking, setChecking] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const entries = [
    ...Object.entries(savedProxies).map(([target, proxy]) => ({ target, proxy, direction: "l1-to-l2" as const })),
    ...Object.entries(savedL2Proxies).map(([target, proxy]) => ({ target, proxy, direction: "l2-to-l1" as const })),
  ];
  const route = crossChainRoute(direction);
  const sourceName = route.source === "l1" ? config.l1NetworkName : config.rollupName;
  const destinationName = route.destination === "l1" ? config.l1NetworkName : config.rollupName;
  const proxy = getProxy(targetAddress, direction) || (detected?.target === targetAddress && detected.direction === direction ? detected.proxy : null);
  const busy = selecting || !["idle", "confirmed", "failed"].includes(state.phase);
  const creating = state.phase === "creating-proxy" || state.phase === "proxy-pending";

  useEffect(() => { if (entries.length === 0) setDeployOpen(true); }, [entries.length]);
  useEffect(() => {
    const target = targetAddress.trim();
    let cancelled = false;
    setDetected(null); setChecking(false);
    onProxyDetected(null, target, direction);
    if (!/^0x[0-9a-f]{40}$/i.test(target) || getProxy(target, direction)) return;
    setChecking(true);
    void (async () => {
      try {
        const computed = await computeProxyAddress(target, direction);
        if (!computed || cancelled) return;
        const code = await rpcCall(crossChainRoute(direction).rpc, "eth_getCode", [computed, "latest"]);
        if (!cancelled && typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(code)) {
          setDetected({ proxy: computed, target: targetAddress, direction });
          onProxyDetected(computed, targetAddress, direction);
        }
      } catch { /* An unavailable manager does not imply that the destination address is invalid. */ }
      finally { if (!cancelled) setChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [targetAddress, direction, getProxy, computeProxyAddress, onProxyDetected]);

  useEffect(() => {
    const handler = (event: MouseEvent) => { if (!dropdownRef.current?.contains(event.target as Node)) setShowRecent(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return <div className={`${styles.card} ${embedded ? styles.embedded : ""}`}>
    <div className={styles.cardHeader}>
      <div className={styles.headerLeft}><span className={styles.cardTitle}>{embedded ? "[ SELECT A PROXY ]" : "Cross-Chain Proxies"}</span>
        {entries.length > 0 && <span className={styles.countBadge}>{entries.length}</span>}</div>
      <button className={styles.deployToggle} disabled={busy} onClick={() => setDeployOpen(!deployOpen)} aria-expanded={deployOpen}>
        {deployOpen ? "Hide address" : "Add address"}</button>
    </div>
    {entries.length > 0 ? <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th className={styles.th}>Destination</th><th className={styles.th}>Proxy</th><th className={styles.thNarrow}>Network</th><th className={styles.thNarrow}>Actions</th></tr></thead>
      <tbody>{entries.map(entry => <ProxyRow key={`${entry.direction}:${entry.target}`} {...entry}
        selected={entry.direction === direction && entry.target.toLowerCase() === targetAddress.toLowerCase()} disabled={busy}
        onSelect={() => { if (onSelectProxy) onSelectProxy(entry.target, entry.direction); else onTargetChange(entry.target); }} />)}</tbody>
    </table></div> : <div className={styles.emptyState}><span className={styles.emptyText}>No saved proxies yet</span></div>}
    <div className={`${styles.deploySection} ${deployOpen ? styles.deployOpen : styles.deployClosed}`}>
      <div className={styles.deployInner}>
        <div className={styles.deploySeparator} />
        {onDirectionChange && <div className={styles.directionSelector} role="group" aria-label="Cross-chain call direction">
          {(["l1-to-l2", "l2-to-l1"] as const).map(value => { const r = crossChainRoute(value); return <button key={value}
            className={`${styles.directionButton} ${direction === value ? styles.directionActive : ""}`} disabled={busy}
            aria-pressed={direction === value} aria-label={value === "l1-to-l2" ? "Call L1 to L2" : "Call L2 to L1"} onClick={() => onDirectionChange(value)}>
            <NetworkIcon chain={r.source} /><span aria-hidden="true">→</span><NetworkIcon chain={r.destination} />
          </button>; })}
        </div>}
        {creating && <div className={styles.phaseBar}><span className={styles.spinner} />
          {state.phase === "creating-proxy" ? `Creating proxy on ${sourceName}…` : `Waiting for confirmation on ${sourceName}…`}</div>}
        {state.phase === "failed" && !state.calldata && state.error && <div className={styles.errorBar}>{state.error}<button className={styles.dismissBtn} onClick={onReset}>Dismiss</button></div>}
        {state.txHash && !state.calldata && <TxLink hash={state.txHash} chain={crossChainRoute(state.direction).source} />}
        <label htmlFor="cross-chain-target" className={styles.sectionTitle}>Destination address · {destinationName}</label>
        <div ref={dropdownRef} className={styles.inputWrapper}>
          <div className={styles.inputGroup}>
            <input id="cross-chain-target" type="text" className={styles.input} value={targetAddress} disabled={busy}
              onChange={event => onTargetChange(event.target.value)} onFocus={() => recentAddresses.length > 0 && setShowRecent(true)} placeholder="0x... contract or EOA address" />
            {proxy ? <div className={styles.proxyBadge}>Proxy available</div> : checking ? <div className={styles.checkingLabel}><span className={styles.checkSpinner} />Checking…</div> :
              /^0x[0-9a-f]{40}$/i.test(targetAddress) && <button className={styles.deployBtn} disabled={busy} onClick={() => onCreateProxy(targetAddress, direction)}>Create proxy</button>}
          </div>
          {showRecent && !busy && recentAddresses.length > 0 && <div className={styles.recentDropdown}><div className={styles.recentHeader}>Recent addresses</div>
            {recentAddresses.map(address => <button key={address} className={styles.recentItem} onMouseDown={event => { event.preventDefault(); onTargetChange(address); setShowRecent(false); }}>
              {lookupAddressForChain(address, route.destination) || `${address.slice(0, 10)}…${address.slice(-6)}`}</button>)}</div>}
        </div>
        {contractName && <div className={styles.contractBadge}>{contractName}</div>}
        {proxy && <div className={styles.proxyAddrRow}><span className={styles.proxyLabel}>Proxy · {sourceName}</span><ExplorerLink value={proxy} chain={route.source} className={styles.proxyValue} /></div>}
      </div>
    </div>
  </div>;
}
