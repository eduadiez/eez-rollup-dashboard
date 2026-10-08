import { useCallback, useEffect, useState } from "react";
import { config, ESTIMATION_SENDER } from "../config";
import { rpcCall } from "../rpc";
import { estimateGas, estimateComposerGas, gasToHex } from "../lib/gasEstimation";

export type CrossChainDirection = "l1-to-l2" | "l2-to-l1";
export type CrossChainPhase = "idle" | "creating-proxy" | "proxy-pending" | "sending" | "l1-pending" | "l2-pending" | "confirmed" | "failed";
export interface CrossChainState {
  phase: CrossChainPhase;
  direction: CrossChainDirection;
  proxyAddress: string;
  targetAddress: string;
  calldata: string;
  txHash: string | null;
  error: string | null;
}
type Logger = (msg: string, type?: "ok" | "err" | "info") => void;
type Sender = (params: Record<string, string>) => Promise<string>;
const IDLE: CrossChainState = { phase: "idle", direction: "l1-to-l2", proxyAddress: "", targetAddress: "", calldata: "", txHash: null, error: null };
const storageKey = (direction: CrossChainDirection) => direction === "l1-to-l2" ? "crossChainProxies" : "crossChainProxiesL2";
const validAddress = (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address);

export function crossChainRoute(direction: CrossChainDirection) {
  const forward = direction === "l1-to-l2";
  return {
    source: forward ? "l1" as const : "l2" as const,
    destination: forward ? "l2" as const : "l1" as const,
    rpc: forward ? config.l1Rpc : config.l2Rpc,
    composerRpc: forward ? config.l1ProxyRpc : config.l2ProxyRpc,
    manager: forward ? config.rollupsAddress : config.ccmL2Address,
    remoteRollupId: forward ? config.rollupId : "0",
  };
}
function loadProxies(direction: CrossChainDirection): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(direction)) || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([target, proxy]) => validAddress(target) && typeof proxy === "string" && validAddress(proxy))
      .map(([target, proxy]) => [target.toLowerCase(), proxy as string]));
  } catch { return {}; }
}
function encodeTarget(address: string, rollupId: string) {
  return address.slice(2).toLowerCase().padStart(64, "0") + BigInt(rollupId).toString(16).padStart(64, "0");
}

export function useCrossChain(log: Logger, sendL1Tx: Sender, sendL1ProxyTx: Sender, options?: {
  sendL2Tx: Sender; sendL2ProxyTx: Sender; senderAddress: string | null; ready?: boolean;
}) {
  const [state, setState] = useState<CrossChainState>(IDLE);
  const [savedProxies, setSavedProxies] = useState(() => loadProxies("l1-to-l2"));
  const [savedL2Proxies, setSavedL2Proxies] = useState(() => loadProxies("l2-to-l1"));
  const sendL2Tx = options?.sendL2Tx;
  const sendL2ProxyTx = options?.sendL2ProxyTx;
  const sender = options?.senderAddress || ESTIMATION_SENDER;
  const ready = options?.ready ?? true;

  // Preserve the existing chain-reset cleanup, scoped to each source network.
  // A failed RPC check must never erase a user's saved mapping.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    for (const direction of ["l1-to-l2", "l2-to-l1"] as const) void (async () => {
      const missing: [string, string][] = [];
      for (const [target, proxy] of Object.entries(loadProxies(direction))) {
        try {
          const code = await rpcCall(crossChainRoute(direction).rpc, "eth_getCode", [proxy, "latest"]);
          if (code === "0x" || code === "0x0") missing.push([target, proxy]);
        } catch { /* Keep the mapping until an on-chain absence is confirmed. */ }
        if (cancelled) return;
      }
      if (!missing.length) return;
      const next = loadProxies(direction);
      for (const [target, proxy] of missing) if (next[target] === proxy) delete next[target];
      localStorage.setItem(storageKey(direction), JSON.stringify(next));
      (direction === "l1-to-l2" ? setSavedProxies : setSavedL2Proxies)(next);
    })();
    return () => { cancelled = true; };
  }, [ready]);

  const saveProxy = useCallback((target: string, proxy: string, direction: CrossChainDirection) => {
    if (!validAddress(proxy)) return;
    // Read storage fresh so the demo and generic hook instances do not overwrite each other's proxies.
    const next = { ...loadProxies(direction), [target.toLowerCase()]: proxy };
    localStorage.setItem(storageKey(direction), JSON.stringify(next));
    (direction === "l1-to-l2" ? setSavedProxies : setSavedL2Proxies)(next);
  }, []);

  const getProxy = useCallback((target: string, direction: CrossChainDirection = "l1-to-l2") => {
    const cached = direction === "l1-to-l2" ? savedProxies : savedL2Proxies;
    return loadProxies(direction)[target.toLowerCase()] || cached[target.toLowerCase()] || null;
  }, [savedProxies, savedL2Proxies]);

  const computeProxyAddress = useCallback(async (target: string, direction: CrossChainDirection = "l1-to-l2"): Promise<string | null> => {
    const route = crossChainRoute(direction);
    if (!validAddress(target) || !route.manager || !route.remoteRollupId) return null;
    const result = await rpcCall(route.rpc, "eth_call", [{ to: route.manager,
      data: "0xeb20c0aa" + encodeTarget(target, route.remoteRollupId) }, "latest"]);
    if (typeof result !== "string" || !/^0x[0-9a-f]{64}$/i.test(result)) return null;
    const address = "0x" + result.slice(-40);
    return BigInt(address) === 0n ? null : address;
  }, []);

  const finish = useCallback((transaction: CrossChainState) => {
    setState(transaction);
    if (transaction.phase === "confirmed") setTimeout(() => setState(current => current === transaction ? IDLE : current), 5000);
  }, []);

  const waitForReceipt = useCallback(async (transaction: CrossChainState) => {
    const route = crossChainRoute(transaction.direction);
    // Composer returns a hash before the batch is posted. Allow both source chains time to mine it.
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const receipt = await rpcCall(route.rpc, "eth_getTransactionReceipt", [transaction.txHash]) as { status?: string } | null;
        if (receipt) {
          if (receipt.status !== "0x1") {
            let reason = "";
            try {
              const tx = await rpcCall(route.rpc, "eth_getTransactionByHash", [transaction.txHash]) as { from?: string; to?: string; input?: string; value?: string; blockNumber?: string } | null;
              if (tx?.to) await rpcCall(route.rpc, "eth_call", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, tx.blockNumber || "latest"]);
            } catch (error) { reason = error instanceof Error ? error.message : String(error); }
            throw new Error(`Transaction reverted on ${route.source.toUpperCase()}${reason ? `: ${reason}` : ""}`);
          }
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Transaction reverted")) throw error;
        // A temporary read-RPC failure must not be treated as a failed transaction.
      }
    }
    throw new Error(`No ${route.source.toUpperCase()} receipt after 60s. The transaction may still confirm; check the explorer.`);
  }, []);

  const createProxy = useCallback(async (target: string, direction: CrossChainDirection = "l1-to-l2") => {
    const route = crossChainRoute(direction);
    const transaction = { ...IDLE, direction, targetAddress: target, phase: "creating-proxy" as CrossChainPhase };
    setState(transaction);
    try {
      if (!validAddress(target)) throw new Error("Enter a valid destination address");
      if (!route.manager || !route.remoteRollupId) throw new Error("Proxy manager is not configured on " + route.source.toUpperCase());
      const send = direction === "l1-to-l2" ? sendL1Tx : sendL2Tx;
      if (!send) throw new Error("L2 wallet submission is not available");
      const proxy = await computeProxyAddress(target, direction);
      if (!proxy) throw new Error("Unable to compute the proxy address");
      const code = await rpcCall(route.rpc, "eth_getCode", [proxy, "latest"]);
      if (code && code !== "0x" && code !== "0x0") {
        saveProxy(target, proxy, direction);
        finish({ ...transaction, phase: "confirmed", proxyAddress: proxy });
        return;
      }
      const data = "0xa7587c62" + encodeTarget(target, route.remoteRollupId);
      let gas: string | undefined;
      try { gas = gasToHex((await estimateGas({ rpcUrl: route.rpc, to: route.manager, data, from: sender })).gasLimit); }
      catch { /* Proxy deployment is a local transaction; the wallet may estimate it. */ }
      const hash = await send({ to: route.manager, data, ...(gas ? { gas } : {}) });
      const pending = { ...transaction, phase: "proxy-pending" as CrossChainPhase, proxyAddress: proxy, txHash: hash };
      setState(pending);
      await waitForReceipt(pending);
      saveProxy(target, proxy, direction);
      finish({ ...pending, phase: "confirmed" });
      log(`Proxy created on ${route.source.toUpperCase()} at ${proxy}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState(current => ({ ...current, phase: "failed", error: message }));
      log(message, "err");
    }
  }, [sendL1Tx, sendL2Tx, sender, computeProxyAddress, saveProxy, finish, waitForReceipt, log]);

  const sendCrossChainCall = useCallback(async (proxy: string, calldata: string, target?: string, value = "0x0", gas?: string,
    direction: CrossChainDirection = "l1-to-l2") => {
    const route = crossChainRoute(direction);
    const transaction = { ...IDLE, direction, proxyAddress: proxy, targetAddress: target || "", calldata, phase: "sending" as CrossChainPhase };
    setState(transaction);
    try {
      if (!validAddress(proxy) || !/^0x(?:[0-9a-f]{2})*$/i.test(calldata)) throw new Error("Enter a valid proxy address and hexadecimal calldata");
      const send = direction === "l1-to-l2" ? sendL1ProxyTx : sendL2ProxyTx;
      if (!send) throw new Error("L2 wallet submission is not available");
      const chosenGas = gas || gasToHex((await estimateComposerGas({ rpcUrl: route.composerRpc, from: sender, to: proxy, data: calldata, value })).gasLimit);
      const hash = await send({ to: proxy, data: calldata, value, gas: chosenGas });
      const pending = { ...transaction, phase: (direction === "l1-to-l2" ? "l1-pending" : "l2-pending") as CrossChainPhase, txHash: hash };
      setState(pending);
      await waitForReceipt(pending);
      finish({ ...pending, phase: "confirmed" });
      log(`Cross-chain call confirmed on ${route.source.toUpperCase()}`, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState(current => ({ ...current, phase: "failed", error: message }));
      log(message, "err");
    }
  }, [sendL1ProxyTx, sendL2ProxyTx, sender, waitForReceipt, finish, log]);

  const reset = useCallback(() => setState(IDLE), []);
  return { state, savedProxies, savedL2Proxies, createProxy, sendCrossChainCall, computeProxyAddress, getProxy, reset };
}
