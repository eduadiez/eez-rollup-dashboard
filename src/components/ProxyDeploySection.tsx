import { useState, useEffect, useRef } from "react";
import { crossChainRoute, type CrossChainState, type CrossChainDirection } from "../hooks/useCrossChain";
import { useBlockscoutAbi } from "../hooks/useBlockscoutAbi";
import { config } from "../config";
import { rpcCall } from "../rpc";
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
  onSaveProxy: (target: string, proxy: string, direction: CrossChainDirection) => Promise<void>;
  onLookupProxy: (proxy: string, direction: CrossChainDirection) => Promise<string>;
  onRemoveProxy: (target: string, direction: CrossChainDirection) => void;
  getProxy: (target: string, direction?: CrossChainDirection) => string | null;
  computeProxyAddress: (target: string, direction?: CrossChainDirection) => Promise<string | null>;
  onProxyDetected: (proxy: string | null, target: string, direction: CrossChainDirection) => void;
  selecting?: boolean;
}

type ProxyLookup = { status: "idle" | "looking" } | { status: "found"; target: string; proxy: string; direction: CrossChainDirection } | { status: "error"; message: string };

function ProxyRow({ target, proxy, direction, selected, disabled, onSelect, onRemove }: {
  target: string; proxy: string; direction: CrossChainDirection; selected: boolean; disabled: boolean; onSelect: () => void; onRemove: () => void;
}) {
  const route = crossChainRoute(direction);
  const sourceName = route.source === "l1" ? config.l1NetworkName : config.rollupName;
  const destinationName = route.destination === "l1" ? config.l1NetworkName : config.rollupName;
  const { contractName } = useBlockscoutAbi(target, route.destination);
  return <tr className={`${styles.row} ${selected ? styles.selectedRow : ""}`}>
    <td className={styles.tdNarrow}><span className={styles.network} role="group" aria-label={`Origin network: ${sourceName}`} title={sourceName}><NetworkIcon chain={route.source} decorative /></span></td>
    <td className={styles.td}><ExplorerLink value={proxy} chain={route.source} label={contractName ? `${contractName} proxy` : lookupAddressForChain(proxy, route.source) || `${proxy.slice(0, 10)}…${proxy.slice(-6)}`} className={styles.addrLink} /></td>
    <td className={styles.arrowCell}><span aria-hidden="true">→</span></td>
    <td className={styles.tdNarrow}><span className={styles.network} role="group" aria-label={`Destination network: ${destinationName}`} title={destinationName}><NetworkIcon chain={route.destination} decorative /></span></td>
    <td className={styles.td}><ExplorerLink value={target} chain={route.destination} label={contractName || lookupAddressForChain(target, route.destination) || `${target.slice(0, 10)}…${target.slice(-6)}`} className={styles.addrLink} /></td>
    <td className={styles.tdNarrow}><div className={styles.actions}><button className={styles.callBtn} disabled={disabled} onClick={onSelect} aria-pressed={selected}
      title={`Saved in this browser. Selecting checks the registry address and deployed code on ${route.source === "l1" ? config.l1NetworkName : config.rollupName}.`}
      aria-label={`${selected ? "Selected proxy" : "Select proxy"} for ${target} on ${route.source.toUpperCase()}`}>{selected ? "Selected" : "Select"}</button>
      <button className={styles.removeBtn} disabled={disabled} onClick={onRemove}
        aria-label={`Remove saved proxy for ${target} on ${route.source.toUpperCase()}`} title="Remove from this browser; the deployed proxy stays on-chain.">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
      </button></div></td>
  </tr>;
}

export function ProxyDeploySection({ embedded = false, state, direction = "l1-to-l2", onDirectionChange, onSelectProxy,
  targetAddress, onTargetChange, contractName, recentAddresses, savedProxies, savedL2Proxies = {},
  onCreateProxy, onSaveProxy, onLookupProxy, onRemoveProxy, getProxy, computeProxyAddress, onProxyDetected, selecting = false }: Props) {
  const [showRecent, setShowRecent] = useState(false);
  const [detected, setDetected] = useState<{ proxy: string; target: string; direction: CrossChainDirection } | null>(null);
  const [checking, setChecking] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [proxyInput, setProxyInput] = useState("");
  const [importMode, setImportMode] = useState(false);
  const [lookup, setLookup] = useState<ProxyLookup>({ status: "idle" });
  const [lookupRetry, setLookupRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const entries = [
    ...Object.entries(savedProxies).map(([target, proxy]) => ({ target, proxy, direction: "l1-to-l2" as const })),
    ...Object.entries(savedL2Proxies).map(([target, proxy]) => ({ target, proxy, direction: "l2-to-l1" as const })),
  ];
  const route = crossChainRoute(direction);
  const sourceName = route.source === "l1" ? config.l1NetworkName : config.rollupName;
  const destinationName = route.destination === "l1" ? config.l1NetworkName : config.rollupName;
  const savedProxy = getProxy(targetAddress, direction);
  const proxy = savedProxy || (detected?.target === targetAddress && detected.direction === direction ? detected.proxy : null);
  const candidate = importMode ? proxyInput.trim() : proxy;
  const imported = lookup.status === "found" && lookup.direction === direction && lookup.proxy.toLowerCase() === proxyInput.toLowerCase() ? lookup : null;
  const validTarget = /^0x[0-9a-f]{40}$/i.test(targetAddress) && (!importMode || imported?.target === targetAddress);
  const alreadySaved = !!candidate && savedProxy?.toLowerCase() === candidate.toLowerCase() && validTarget;
  const busy = saving || selecting || !["idle", "confirmed", "failed"].includes(state.phase);
  const save = async () => {
    if (busy || !candidate || !validTarget) return;
    setSaving(true); setSaveError(null); setShowRecent(false);
    try { await onSaveProxy(targetAddress, candidate, direction); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };

  useEffect(() => { setProxyInput(""); setLookup({ status: "idle" }); setSaveError(null); setShowRecent(false); }, [direction]);
  useEffect(() => { if (!importMode) { setSaveError(null); setShowRecent(false); } }, [targetAddress, importMode]);

  const changeInputMode = () => {
    setImportMode(!importMode); setProxyInput(""); setLookup({ status: "idle" }); setSaveError(null); setShowRecent(false);
    onTargetChange(""); onProxyDetected(null, "", direction);
  };

  useEffect(() => {
    if (!importMode || !/^0x[0-9a-f]{40}$/i.test(proxyInput)) { setLookup({ status: "idle" }); return; }
    if (!deployOpen) return;
    let cancelled = false;
    onTargetChange(""); onProxyDetected(null, "", direction);
    setLookup({ status: "looking" });
    const timer = setTimeout(() => { void (async () => {
      try {
        const target = await onLookupProxy(proxyInput, direction);
        if (cancelled) return;
        setLookup({ status: "found", target, proxy: proxyInput, direction });
        onTargetChange(target); onProxyDetected(proxyInput, target, direction);
      } catch (error) {
        if (!cancelled) setLookup({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })(); }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [importMode, deployOpen, proxyInput, direction, lookupRetry, onLookupProxy, onTargetChange, onProxyDetected]);

  useEffect(() => { if (entries.length === 0) setDeployOpen(true); }, [entries.length]);
  useEffect(() => {
    const target = targetAddress.trim();
    let cancelled = false;
    setDetected(null); setChecking(false);
    if (importMode) return;
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
  }, [targetAddress, direction, getProxy, computeProxyAddress, onProxyDetected, importMode]);

  useEffect(() => {
    const handler = (event: MouseEvent) => { if (!dropdownRef.current?.contains(event.target as Node)) setShowRecent(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return <div className={`${styles.card} ${embedded ? styles.embedded : ""}`}>
    <div className={styles.cardHeader}>
      <div className={styles.headerLeft}><span className={styles.cardTitle}>{embedded ? "[ SELECT A PROXY ]" : "Cross-Chain Proxies"}</span>
        {entries.length > 0 && <span className={styles.countBadge}>{entries.length}</span>}</div>
      <button className={styles.deployToggle} disabled={busy} onClick={() => { setDeployOpen(!deployOpen); setShowRecent(false); }} aria-expanded={deployOpen}>
        {deployOpen ? "Hide address" : "Add address"}</button>
    </div>
    {entries.length > 0 ? <div className={styles.tableWrap}><table className={styles.table}>
      <thead><tr><th className={styles.thNarrow}>Origin network</th><th className={styles.th}>Proxy address</th><th className={styles.thArrow} aria-label="Direction" /><th className={styles.thNarrow}>Destination network</th><th className={styles.th}>Destination address</th><th className={styles.thNarrow}>Actions</th></tr></thead>
      <tbody>{entries.map(entry => <ProxyRow key={`${entry.direction}:${entry.target}`} {...entry}
        selected={entry.direction === direction && entry.target.toLowerCase() === targetAddress.toLowerCase()} disabled={busy}
        onSelect={() => { setShowRecent(false); setImportMode(false); setProxyInput(""); if (onSelectProxy) onSelectProxy(entry.target, entry.direction); else onTargetChange(entry.target); }}
        onRemove={() => {
          if (entry.direction === direction && entry.target.toLowerCase() === targetAddress.toLowerCase()) { setProxyInput(""); setLookup({ status: "idle" }); }
          onRemoveProxy(entry.target, entry.direction);
        }} />)}</tbody>
    </table></div> : <div className={styles.emptyState}><span className={styles.emptyText}>No saved proxies yet</span></div>}
    <div className={styles.deploySection} hidden={!deployOpen}>
      <div className={styles.deployInner}>
        <div className={styles.deploySeparator} />
        {onDirectionChange && <div className={styles.directionSelector} role="group" aria-label="Cross-chain call direction">
          {(["l1-to-l2", "l2-to-l1"] as const).map(value => { const r = crossChainRoute(value); return <button key={value}
            className={`${styles.directionButton} ${direction === value ? styles.directionActive : ""}`} disabled={busy}
            aria-pressed={direction === value} aria-label={value === "l1-to-l2" ? "Call L1 to L2" : "Call L2 to L1"} onClick={() => onDirectionChange(value)}>
            <NetworkIcon chain={r.source} /><span aria-hidden="true">→</span><NetworkIcon chain={r.destination} />
          </button>; })}
        </div>}
        <button className={styles.inputModeToggle} disabled={busy} onClick={changeInputMode}>{importMode ? "Select a destination address" : "Use an existing proxy address"}</button>
        {importMode ? <>
          <label htmlFor="existing-proxy-address" className={styles.sectionTitle}>Proxy address on {sourceName}</label>
          <p id="proxy-address-hint" className={styles.fieldHint}>Paste an existing proxy; its destination on {destinationName} is filled automatically.</p>
          <div className={styles.inputGroup}>
            <input id="existing-proxy-address" className={styles.input} value={proxyInput} disabled={busy} spellCheck={false} autoComplete="off"
              aria-describedby={lookup.status === "error" ? "proxy-address-hint proxy-lookup-error" : "proxy-address-hint"} aria-invalid={lookup.status === "error" || undefined}
              onChange={event => { setProxyInput(event.target.value.trim()); setLookup({ status: "idle" }); setSaveError(null); onTargetChange(""); onProxyDetected(null, "", direction); }}
              placeholder={`0x... proxy deployed on ${sourceName}`} />
            {alreadySaved ? <span className={styles.savedLabel}>Saved</span> : <button className="btn btn-solid" disabled={busy || !validTarget || !imported} onClick={() => { void save(); }}>{saving ? "Saving…" : "Save proxy"}</button>}
          </div>
          {lookup.status === "looking" && <span className={styles.checkingLabel} role="status"><span className={styles.checkSpinner} />Finding destination…</span>}
          {lookup.status === "error" && <>
            <p id="proxy-lookup-error" className={styles.saveError} role="alert">{lookup.message}</p>
            <button className={styles.inputModeToggle} disabled={busy} onClick={() => setLookupRetry(value => value + 1)}>Retry lookup</button>
          </>}
          {imported && <div className={styles.detectedDestination} role="group" aria-label="Detected destination">
            <span className={styles.fieldHint}>Destination on {destinationName}</span>
            <ExplorerLink value={imported.target} chain={route.destination} label={contractName || lookupAddressForChain(imported.target, route.destination) || `${imported.target.slice(0, 10)}…${imported.target.slice(-6)}`} />
          </div>}
        </> : <>
        <label htmlFor="cross-chain-target" className={styles.sectionTitle}>Destination address on {destinationName}</label>
        <p id="destination-address-hint" className={styles.fieldHint}>Select the contract or wallet address you want to call.</p>
        <div ref={dropdownRef} className={styles.inputWrapper}>
          <div className={styles.inputGroup}>
            <input id="cross-chain-target" type="text" className={styles.input} value={targetAddress} disabled={busy} spellCheck={false} autoComplete="off" aria-describedby="destination-address-hint"
              onKeyDown={event => { if (event.key === "Escape") setShowRecent(false); else if (event.key === "ArrowDown") setShowRecent(true); }}
              onChange={event => onTargetChange(event.target.value.trim())} onFocus={() => recentAddresses.length > 0 && setShowRecent(true)}
              onClick={() => recentAddresses.length > 0 && setShowRecent(true)} placeholder="0x... contract or EOA address" />
            {alreadySaved ? <span className={styles.savedLabel}>Saved</span> : candidate ?
              <button className="btn btn-solid" disabled={busy || !validTarget || !/^0x[0-9a-f]{40}$/i.test(candidate)} onClick={() => { void save(); }}>{saving ? "Saving…" : "Save proxy"}</button> :
              checking ? <div className={styles.checkingLabel}><span className={styles.checkSpinner} />Checking…</div> :
              /^0x[0-9a-f]{40}$/i.test(targetAddress) && <button className={styles.deployBtn} disabled={busy} onClick={() => onCreateProxy(targetAddress, direction)}>Create proxy</button>}
          </div>
          {showRecent && !busy && recentAddresses.length > 0 && <div className={styles.recentDropdown}><div className={styles.recentHeader}>Recent addresses</div>
            {recentAddresses.map(address => <button key={address} className={styles.recentItem} onClick={() => { onTargetChange(address); setShowRecent(false); }}>
              {lookupAddressForChain(address, route.destination) || `${address.slice(0, 10)}…${address.slice(-6)}`}</button>)}</div>}
        </div>
        </>}
        {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
        {!importMode && contractName && <span className={styles.contractName}>{contractName}</span>}
      </div>
    </div>
  </div>;
}
