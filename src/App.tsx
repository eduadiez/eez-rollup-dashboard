import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "./config";
import { useConfigLoader } from "./hooks/useConfig";
import { useLog } from "./hooks/useLog";
import { useWallet } from "./hooks/useWallet";
import { useDashboard } from "./hooks/useDashboard";
import { useCounter } from "./hooks/useCounter";
import { useCrossChain, crossChainRoute, type CrossChainDirection } from "./hooks/useCrossChain";
import { lookupAddressForChain } from "./lib/addressBook";
import { useBridge } from "./hooks/useBridge";
import { useTxHistory } from "./hooks/useTxHistory";
import { useBlockscoutAbi } from "./hooks/useBlockscoutAbi";
import { useRecentAddresses } from "./hooks/useRecentAddresses";
import { NetworkMonitorView } from "./monitor/NetworkMonitorView";
import { Header } from "./components/Header";
import { CounterPanel } from "./components/CounterPanel";
import { CrossChainPanel } from "./components/CrossChainPanel";
import { ProxyDeploySection } from "./components/ProxyDeploySection";
import { CrossChainCallBuilder } from "./components/CrossChainCallBuilder";
import { CrossChainTransactionDialog } from "./components/CrossChainTransactionDialog";
import { BridgePanel } from "./components/BridgePanel";
import { TxHistoryPanel } from "./components/TxHistoryPanel";
import styles from "./App.module.css";

const VisualizerView = lazy(() => import("./components/VisualizerView").then(module => ({ default: module.VisualizerView })));

// Flash-loan and aggregator views are retained but are not enabled on this network.
type DashboardTab = "dashboard" | "counter-demo";

/** Dashboard sub-tabs that can be deep-linked via hash */
const HASH_TO_TAB: Record<string, DashboardTab> = {
  "counter-demo": "counter-demo",
  // Keep saved bridge links opening the combined dashboard.
  "bridge": "dashboard",
};

function getInitialView(): string {
  const raw = window.location.hash.replace("#/", "").replace("#", "");
  const hash = raw.split("?")[0];
  if (hash === "monitor") return "monitor";
  if (hash === "visualizer") return "visualizer";
  if (window.location.pathname === "/monitor" || window.location.pathname === "/monitor/") return "monitor";
  return "dashboard";
}

function getInitialTab(): DashboardTab {
  const raw = window.location.hash.replace("#/", "").replace("#", "");
  const hash = raw.split("?")[0] || "";
  return HASH_TO_TAB[hash] ?? "dashboard";
}

/** Parse ?key=value from the hash fragment (e.g. #/?target=0x...) */
function getHashParam(key: string): string | null {
  const hash = window.location.hash;
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx));
  return params.get(key);
}

const DASHBOARD_TABS: { id: DashboardTab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "counter-demo", label: "Counter Demo" },
];

export function App() {
  const configLoaded = useConfigLoader();

  const { entries: _entries, log } = useLog();
  const wallet = useWallet(log, configLoaded);
  const { l2 } = useDashboard();
  const counter = useCounter(log, wallet.sendTx);
  const crossChainOptions = { sendL2Tx: wallet.sendTx, sendL2ProxyTx: wallet.sendL2ProxyTx, senderAddress: wallet.address, ready: configLoaded };
  const crossChain = useCrossChain(log, wallet.sendL1Tx, wallet.sendL1ProxyTx, crossChainOptions);
  const crossChainGeneric = useCrossChain(log, wallet.sendL1Tx, wallet.sendL1ProxyTx, crossChainOptions);
  const bridgeHook = useBridge(log, wallet.sendTx, wallet.sendL2ProxyTx, wallet.sendL1Tx, wallet.sendL1ProxyTx, wallet.address, configLoaded);

  const txHistory = useTxHistory();
  const latestBridgeState = useRef(bridgeHook.state);
  latestBridgeState.current = bridgeHook.state;
  const switchBridgeNetwork = async (chain: "l1" | "l2") => {
    const switched = await (chain === "l1" ? wallet.switchToL1() : wallet.switchToL2());
    const direction = chain === "l1" ? "l1-to-l2" : "l2-to-l1";
    if (switched && ["idle", "confirmed", "failed"].includes(latestBridgeState.current.phase)
        && direction !== latestBridgeState.current.direction) bridgeHook.setDirection(direction);
    return switched;
  };

  // Dashboard tab hooks
  const [genericTargetAddr, setGenericTargetAddr] = useState<string>(() => {
    return getHashParam("target") || "";
  });
  const [genericDirection, setGenericDirection] = useState<CrossChainDirection>("l1-to-l2");
  const [selectingProxy, setSelectingProxy] = useState(false);
  const proxySelectionPending = useRef(false);
  const [proxySelectionError, setProxySelectionError] = useState<string | null>(null);
  const destinationChain = crossChainRoute(genericDirection).destination;
  const blockscoutAbi = useBlockscoutAbi(genericTargetAddr, destinationChain);
  const recentAddrs = useRecentAddresses(destinationChain);

  const [view, setView] = useState(getInitialView);
  const [visualizerRoute, setVisualizerRoute] = useState(() => window.location.hash);
  const visualizerParams = new URLSearchParams(visualizerRoute.split("?")[1] ?? "");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>(getInitialTab);

  /** Switch dashboard sub-tab and update hash for deep linking */
  const switchTab = useCallback((tab: DashboardTab) => {
    setDashboardTab(tab);
    window.location.hash = tab === "dashboard" ? "" : `#/${tab}`;
  }, []);

  const navigate = useCallback((v: string) => {
    setView(v);
    const pathname = v === "monitor" ? "/monitor/" : import.meta.env.BASE_URL;
    window.history.pushState(null, "", v === "visualizer" ? `${pathname}#/visualizer` : pathname);
    if (v === "visualizer") setVisualizerRoute(window.location.hash);
    if (v === "dashboard") setDashboardTab("dashboard");
  }, []);

  // Listen for browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const raw = window.location.hash.replace("#/", "").replace("#", "").split("?")[0];
      // Check for target deep link
      const target = getHashParam("target");
      if (target) setGenericTargetAddr(target);
      // Deep link to dashboard sub-tabs (e.g. #/counter-demo, #/bridge)
      const tab = raw ? HASH_TO_TAB[raw] : undefined;
      setDashboardTab(tab ?? "dashboard");
      setView(getInitialView());
      setVisualizerRoute(window.location.hash);
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, []);

  // Track counter demo cross-chain transactions in history
  const ccTxRef = useRef<string | null>(null);
  const prevCCPhase = useRef(crossChain.state.phase);

  useEffect(() => {
    const { phase, txHash, targetAddress } = crossChain.state;

    if (
      (phase === "creating-proxy" || phase === "sending") &&
      prevCCPhase.current !== phase
    ) {
      const type = phase === "creating-proxy" ? "cross-chain-proxy" : "cross-chain-call";
      const label =
        phase === "creating-proxy"
          ? `Proxy for ${targetAddress.slice(0, 10)}...`
          : `Call → ${targetAddress.slice(0, 10)}...`;
      ccTxRef.current = txHistory.addTx(type, label, null, phase === "sending" ? "l1-to-l2" : undefined);
    }

    if (txHash && ccTxRef.current && (phase === "proxy-pending" || phase === "l1-pending")) {
      txHistory.updateTx(ccTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && ccTxRef.current) {
      txHistory.updateTx(ccTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      ccTxRef.current = null;
    }

    prevCCPhase.current = phase;
  }, [crossChain.state.phase, crossChain.state.txHash]);

  // Track generic cross-chain transactions in history
  const ccGenTxRef = useRef<string | null>(null);
  const prevCCGenPhase = useRef(crossChainGeneric.state.phase);

  useEffect(() => {
    const { phase, txHash, targetAddress, direction } = crossChainGeneric.state;

    if (
      (phase === "creating-proxy" || phase === "sending") &&
      prevCCGenPhase.current !== phase
    ) {
      const type = phase === "creating-proxy" ? "cross-chain-proxy" : "cross-chain-call";
      const label =
        phase === "creating-proxy"
          ? `Proxy for ${targetAddress.slice(0, 10)}...`
          : `Call → ${lookupAddressForChain(targetAddress, crossChainRoute(direction).destination) || targetAddress.slice(0, 10) + "…"}`;
      ccGenTxRef.current = txHistory.addTx(type, label, null, direction);
    }

    if (txHash && ccGenTxRef.current && (phase === "proxy-pending" || phase === "l1-pending" || phase === "l2-pending")) {
      txHistory.updateTx(ccGenTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && ccGenTxRef.current) {
      txHistory.updateTx(ccGenTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      ccGenTxRef.current = null;
    }

    prevCCGenPhase.current = phase;
  }, [crossChainGeneric.state.phase, crossChainGeneric.state.txHash]);

  // Track bridge transactions in history
  const bridgeTxRef = useRef<string | null>(null);
  const prevBridgePhase = useRef(bridgeHook.state.phase);

  useEffect(() => {
    const { phase, txHash, direction, asset, amount, tokenMeta } = bridgeHook.state;

    if (phase === "sending" && prevBridgePhase.current !== "sending") {
      const symbol = asset === "eth" ? (direction === "l1-to-l2" ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol : (tokenMeta?.symbol || "tokens");
      const dirLabel = direction === "l1-to-l2" ? "L1\u2192L2" : "L2\u2192L1";
      bridgeTxRef.current = txHistory.addTx(
        "bridge",
        `Bridge ${amount} ${symbol} ${dirLabel}`,
        null,
        direction,
      );
    }

    if (txHash && bridgeTxRef.current && phase === "tx-pending") {
      txHistory.updateTx(bridgeTxRef.current, { hash: txHash });
    }

    if ((phase === "confirmed" || phase === "failed") && bridgeTxRef.current) {
      txHistory.updateTx(bridgeTxRef.current, {
        status: phase === "confirmed" ? "confirmed" : "failed",
        hash: txHash ?? undefined,
      });
      bridgeTxRef.current = null;
    }

    prevBridgePhase.current = phase;
  }, [bridgeHook.state.phase, bridgeHook.state.txHash]);

  // Track auto-detected proxy from ProxyDeploySection (on-chain but not in localStorage)
  const [autoDetectedProxy, setAutoDetectedProxy] = useState<{ address: string; target: string; direction: CrossChainDirection } | null>(null);
  const handleProxyDetected = useCallback((address: string | null, target: string, direction: CrossChainDirection) => {
    setAutoDetectedProxy(address ? { address, target, direction } : null);
  }, []);

  // A newly verified on-chain proxy takes priority over an older browser mapping.
  const savedProxy = genericTargetAddr
    ? crossChainGeneric.getProxy(genericTargetAddr, genericDirection)
    : null;
  const genericProxy = (autoDetectedProxy?.target === genericTargetAddr && autoDetectedProxy.direction === genericDirection ? autoDetectedProxy.address : null) || savedProxy;

  const selectGenericProxy = async (target: string, direction: CrossChainDirection) => {
    if (proxySelectionPending.current || !["idle", "confirmed", "failed"].includes(crossChainGeneric.state.phase)) return;
    proxySelectionPending.current = true;
    setSelectingProxy(true); setProxySelectionError(null);
    try {
      const cached = crossChainGeneric.getProxy(target, direction);
      if (cached) await crossChainGeneric.verifyProxy(target, cached, direction);
      if (wallet.address && !await switchBridgeNetwork(crossChainRoute(direction).source)) {
        setProxySelectionError("Wallet network switch was cancelled. Your selected proxy has not changed.");
        return;
      }
      crossChainGeneric.reset();
      setGenericDirection(direction); setGenericTargetAddr(target);
    } catch (error) {
      setProxySelectionError(`Cannot verify proxy: ${error instanceof Error ? error.message : String(error)}`);
    } finally { proxySelectionPending.current = false; setSelectingProxy(false); }
  };

  // Wrapper for generic sendCrossChainCall that also saves to recent addresses
  const handleGenericSendCall = useCallback(
    (proxy: string, calldata: string, target?: string, _value?: string, gas?: string) => {
      if (target) recentAddrs.addAddress(target);
      crossChainGeneric.sendCrossChainCall(proxy, calldata, target, _value, gas, genericDirection);
    },
    [crossChainGeneric, recentAddrs, genericDirection],
  );

  if (!configLoaded) return null;

  return (
    <>
      <a className="eez-skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Header
        wallet={wallet}
        walletName={wallet.walletName}
        walletOptions={wallet.walletOptions}
        onConnect={wallet.connect}
        onDisconnect={wallet.disconnect}
        onNavigate={navigate}
        currentView={view}
        theme="dark"
        currentChainId={wallet.chainId}
        onSwitchL1={() => { void switchBridgeNetwork("l1"); }}
        onSwitchL2={() => { void switchBridgeNetwork("l2"); }}
      />

      {view === "monitor" ? (
        <NetworkMonitorView />
      ) : view === "visualizer" ? (
        <Suspense fallback={<main id="main" tabIndex={-1} className={styles.page}>Loading visualizer…</main>}>
          <VisualizerView
            key={visualizerRoute}
            onBack={() => navigate("dashboard")}
            initialDebugHash={visualizerParams.get("tx") ?? visualizerParams.get("debug")}
            initialMode={visualizerParams.get("mode")}
            initialChain={visualizerParams.get("chain")}
            initialBlock={visualizerParams.get("block")}
            initialCounterpart={visualizerParams.get("counterpart")}
            initialBatch={visualizerParams.get("batch")}
            initialSelected={visualizerParams.get("selected")}
            initialSelectedChain={visualizerParams.get("selectedChain")}
            initialEvent={visualizerParams.get("event")}
            initialTab={visualizerParams.get("tab")}
            initialCall={visualizerParams.get("call")}
          />
        </Suspense>
      ) : (
        <main id="main" tabIndex={-1} className={styles.page} data-dashboard>
          <section className={`${styles.intro} eez-intro`} aria-labelledby="page-heading">
            <div>
              <p className="eez-eyebrow">[ NETWORK DASHBOARD ]</p>
              <h1 id="page-heading" className="eez-page-heading"><strong>Dashboard.</strong> With EEZ.</h1>
              <p className="eez-description">Transfer assets and interact with contracts across L1 and L2.</p>
            </div>
            <a className="eez-pill" href="https://eez-demos.vercel.app/" target="_blank" rel="noopener noreferrer">
              Quickstarts <span className="eez-arrow" aria-hidden="true">→</span>
            </a>
          </section>

          <nav className={styles.tabs} aria-label="Dashboard sections">
            {DASHBOARD_TABS.map((tab) => (
              <button
                key={tab.id}
                className={`${styles.tab} ${dashboardTab === tab.id ? styles.tabActive : ""}`}
                aria-current={dashboardTab === tab.id ? "page" : undefined}
                onClick={() => switchTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {dashboardTab === "dashboard" && (
              <div className={styles.dashboardGrid}>
                <section className={styles.bridgeColumn} aria-label="Bridge transfers">
                  <BridgePanel
                    state={bridgeHook.state}
                    recentTokens={bridgeHook.recentTokens}
                    walletAddress={wallet.address}
                    onSetDirection={bridgeHook.setDirection}
                    onSetAsset={bridgeHook.setAsset}
                    onSetAmount={bridgeHook.setAmount}
                    onSetDestination={bridgeHook.setDestination}
                    onSetTokenAddress={bridgeHook.setTokenAddress}
                    onSetMax={bridgeHook.setMax}
                    onApprove={bridgeHook.approve}
                    onBridge={bridgeHook.bridge}
                    onDismiss={bridgeHook.dismiss}
                    onGasOverride={bridgeHook.setGasOverride}
                  />
                </section>

                <section className={styles.proxyColumn} aria-label="Cross-chain contracts">
                  <div className={styles.workflowHeader}>
                    <h2>Cross-Chain Calls</h2>
                    <p>Call a contract or address on either network through its proxy.</p>
                  </div>
                  <ProxyDeploySection
                    embedded
                    direction={genericDirection}
                    selecting={selectingProxy}
                    onDirectionChange={direction => { void selectGenericProxy("", direction); }}
                    onSelectProxy={(target, direction) => { void selectGenericProxy(target, direction); }}
                    state={crossChainGeneric.state}
                    targetAddress={genericTargetAddr}
                    onTargetChange={setGenericTargetAddr}
                    contractName={blockscoutAbi.contractName}
                    recentAddresses={recentAddrs.addresses}
                    savedProxies={crossChainGeneric.savedProxies}
                    savedL2Proxies={crossChainGeneric.savedL2Proxies}
                    onCreateProxy={crossChainGeneric.createProxy}
                    onSaveProxy={crossChainGeneric.registerProxy}
                    onLookupProxy={crossChainGeneric.lookupProxy}
                    onRemoveProxy={(target, direction) => {
                      crossChainGeneric.removeProxy(target, direction);
                      if (direction === genericDirection && target.toLowerCase() === genericTargetAddr.toLowerCase()) {
                        setGenericTargetAddr(""); setAutoDetectedProxy(null); crossChainGeneric.reset();
                      }
                      setProxySelectionError(null);
                    }}
                    getProxy={crossChainGeneric.getProxy}
                    computeProxyAddress={crossChainGeneric.computeProxyAddress}
                    onProxyDetected={handleProxyDetected}
                  />
                  {proxySelectionError && <p role="alert">{proxySelectionError}</p>}

                  <CrossChainCallBuilder
                    embedded
                    key={`${genericDirection}:${genericTargetAddr}:${genericProxy}`}
                    direction={genericDirection}
                    selecting={selectingProxy}
                    targetAddress={genericTargetAddr}
                    proxyAddress={genericProxy}
                    abi={blockscoutAbi.abi}
                    abiLoading={blockscoutAbi.loading}
                    abiError={blockscoutAbi.error}
                    contractName={blockscoutAbi.contractName}
                    crossChainState={crossChainGeneric.state}
                    onSendCall={handleGenericSendCall}
                    destinationRpc={destinationChain === "l1" ? config.l1Rpc : config.l2Rpc}
                    senderAddress={wallet.address}
                  />
                  <CrossChainTransactionDialog state={crossChainGeneric.state} onDismiss={crossChainGeneric.reset} />
                </section>
              </div>
            )}

            {dashboardTab === "counter-demo" && (
              <>
                <CounterPanel
                  address={counter.address}
                  onAddressChange={counter.setAddress}
                  count={counter.count}
                  prevCount={counter.prevCount}
                  deploying={counter.deploying}
                  incrementing={counter.incrementing}
                  txStatus={counter.txStatus}
                  totalIncrements={counter.totalIncrements}
                  onDeploy={counter.deploy}
                  onIncrement={counter.increment}
                  onRefresh={counter.refresh}
                  connected={l2.blockNumber !== null}
                />

                <CrossChainPanel
                  state={crossChain.state}
                  counterAddress={counter.address}
                  count={counter.count}
                  prevCount={counter.prevCount}
                  savedProxies={crossChain.savedProxies}
                  onCreateProxy={crossChain.createProxy}
                  onSendCall={crossChain.sendCrossChainCall}
                  getProxy={crossChain.getProxy}
                  onReset={crossChain.reset}
                />
              </>
            )}

            <TxHistoryPanel
              records={txHistory.records}
              onClear={txHistory.clearHistory}
              onInspect={(hash, chain) => { window.location.hash = `#/visualizer?mode=inspect&chain=${chain}&tx=${hash}`; }}
            />


          </div>
        </main>
      )}
      <footer className={styles.footer}>
        <span>[ EEZ NETWORK ]</span>
        <a href="https://eez-demos.vercel.app/" target="_blank" rel="noopener noreferrer">Learn how EEZ works ↗</a>
      </footer>
    </>
  );
}
