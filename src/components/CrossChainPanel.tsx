import { useEffect, useState } from "react";
import { config } from "../config";
import { rpcCall } from "../rpc";
import { crossChainRoute, type CrossChainDirection, type CrossChainState } from "../hooks/useCrossChain";
import type { AbiFunction } from "../hooks/useBlockscoutAbi";
import { NetworkIcon } from "./NetworkIcon";
import { CrossChainCallBuilder } from "./CrossChainCallBuilder";
import { CrossChainTransactionDialog } from "./CrossChainTransactionDialog";
import styles from "./CrossChainPanel.module.css";

interface Props {
  state: CrossChainState; direction: CrossChainDirection;
  counterAddress: string; counterReady: boolean; senderAddress: string | null; locked: boolean;
  onCreateProxy: (target: string, direction: CrossChainDirection) => void;
  onSendCall: (proxy: string, calldata: string, target?: string, value?: string, gas?: string, direction?: CrossChainDirection) => void;
  getProxy: (target: string, direction: CrossChainDirection) => string | null;
  computeProxyAddress: (target: string, direction: CrossChainDirection) => Promise<string | null>;
  verifyProxy: (target: string, proxy: string, direction: CrossChainDirection) => Promise<void>;
  onReset: () => void;
}
// Built-in ABI for the SimpleCounter deployed by this demo; no explorer dependency.
const COUNTER_FUNCTIONS: AbiFunction[] = [
  { name: "increment", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { name: "getCount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "count", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
];
type ProxyResult = { key: string; status: "checking" | "missing" | "ready" | "error"; proxy: string | null; error?: string };

export function CrossChainPanel({ state, direction, counterAddress, counterReady, senderAddress, locked,
  onCreateProxy, onSendCall, getProxy, computeProxyAddress, verifyProxy, onReset }: Props) {
  const route = crossChainRoute(direction);
  const sourceName = route.source === "l1" ? config.l1NetworkName : config.rollupName;
  const destinationName = route.destination === "l1" ? config.l1NetworkName : config.rollupName;
  const key = `${direction}:${counterAddress.toLowerCase()}`;
  const [result, setResult] = useState<ProxyResult | null>(null), [retry, setRetry] = useState(0);
  const validTarget = /^0x[0-9a-f]{40}$/i.test(counterAddress) && counterReady;
  const busy = locked || !["idle", "confirmed", "failed"].includes(state.phase);
  const current = validTarget && result?.key === key ? result : null;
  const proxy = current?.status === "ready" ? current.proxy : null;

  useEffect(() => {
    if (!validTarget) return;
    let cancelled = false;
    setResult({ key, status: "checking", proxy: null });
    void (async () => {
      try {
        const candidate = getProxy(counterAddress, direction) || await computeProxyAddress(counterAddress, direction);
        if (!candidate) throw new Error(`Proxy manager is unavailable on ${sourceName}`);
        const code = await rpcCall(route.rpc, "eth_getCode", [candidate, "latest"]);
        if (cancelled) return;
        if (code === "0x" || code === "0x0") { setResult({ key, status: "missing", proxy: null }); return; }
        await verifyProxy(counterAddress, candidate, direction);
        if (!cancelled) setResult({ key, status: "ready", proxy: candidate });
      } catch (error) {
        if (!cancelled) setResult({ key, status: "error", proxy: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [validTarget, key, counterAddress, direction, getProxy, computeProxyAddress, verifyProxy, retry, route.rpc, sourceName]);

  return <section className={styles.card} aria-label="Counter cross-chain calls">
    <div className={styles.header}><h2>Cross-Chain Calls</h2><p>Control the counter on {destinationName} from {sourceName}.</p></div>
    {!proxy && <>
      <div className={styles.route} role="group" aria-label="Counter call direction">
        <span><NetworkIcon chain={route.source} decorative />{sourceName}</span><span aria-hidden="true">→</span>
        <span><NetworkIcon chain={route.destination} decorative />{destinationName}</span>
      </div>
      {!validTarget ? <p className={styles.hint}>Deploy or select a counter on {destinationName} to prepare a cross-chain call.</p> :
        current?.status === "error" ? <><p className={styles.error} role="alert">{current.error}</p><button className="btn btn-outline" disabled={busy} onClick={() => setRetry(value => value + 1)}>Retry proxy lookup</button></> :
        current?.status === "missing" ? <div className={styles.setup}><p className={styles.hint}>Create a proxy on {sourceName} that forwards calls to this counter on {destinationName}.</p>
          <button className="btn btn-solid" disabled={busy || !senderAddress} onClick={() => onCreateProxy(counterAddress, direction)}>Create proxy on {sourceName}</button></div> :
          <p className={styles.hint} role="status">Checking the proxy on {sourceName}…</p>}
    </>}
    {proxy && <CrossChainCallBuilder embedded key={`${key}:${proxy}`} direction={direction} selecting={locked}
      targetAddress={counterAddress} proxyAddress={proxy} abi={COUNTER_FUNCTIONS} abiLoading={false} abiError={null}
      contractName="SimpleCounter" crossChainState={state} senderAddress={senderAddress} destinationRpc={route.destination === "l1" ? config.l1Rpc : config.l2Rpc}
      onSendCall={(address, data, target, value, gas) => onSendCall(address, data, target, value, gas, direction)} />}
    <CrossChainTransactionDialog state={state} onDismiss={onReset} />
  </section>;
}
