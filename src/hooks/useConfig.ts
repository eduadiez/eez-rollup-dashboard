import { useEffect, useState } from "react";
import { config, setConfig, L1_CHAIN, L2_CHAIN } from "../config";
import { rpcCall } from "../rpc";
import { registerConfiguredContracts } from "../lib/addressBook";

type RuntimeConfig = {
  l1RpcUrl?: string;
  l2RpcUrl?: string;
  l1FrontUrl?: string;
  l2FrontUrl?: string;
  l1ExplorerUrl?: string;
  l2ExplorerUrl?: string;
  l2ExplorerApiUrl?: string;
  l1ContractAddress?: string;
  l2ContractAddress?: string;
  bridgeL1Address?: string;
  bridgeL2Address?: string;
  rollupId?: string;
  demoBridgeAddress?: string;
  demoTokenAddress?: string;
  demoPoolAddress?: string;
  demoExecutorL1?: string;
  demoExecutorL2?: string;
  demoWrappedTokenL2?: string;
  demoNftL2?: string;
  reverseExecutorL2?: string;
  reverseNftL1?: string;
  reverseExecutorL1?: string;
  aggWeth?: string;
  aggUsdc?: string;
  aggL1Amm?: string;
  aggAggregator?: string;
  aggL2Executor?: string;
  aggL2Amm?: string;
  aggL2ExecutorProxy?: string;
  aggWrappedWethL2?: string;
  aggWrappedUsdcL2?: string;
};

function absoluteUrl(value: string | undefined): string | undefined {
  return value ? new URL(value, window.location.origin).toString() : undefined;
}

/** Loads runtime config and auto-detects chain IDs from RPCs. */
export function useConfigLoader() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      // Current EEZ/Kurtosis runtime configuration. The mapping below is the
      // compatibility layer between the POC UI names and the current network.
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}config.json`);
        if (response.ok) {
          const payload = (await response.json()) as RuntimeConfig & { browser?: RuntimeConfig };
          const runtime: RuntimeConfig = payload.browser ?? payload;
          const l1Rpc = absoluteUrl(runtime.l1RpcUrl);
          const l2Rpc = absoluteUrl(runtime.l2RpcUrl);
          const l1ProxyRpc = absoluteUrl(runtime.l1FrontUrl);
          const l2ProxyRpc = absoluteUrl(runtime.l2FrontUrl);
          setConfig({
            ...(l1Rpc ? { l1Rpc } : {}),
            ...(l2Rpc ? { l2Rpc } : {}),
            ...(l1ProxyRpc ? { l1ProxyRpc } : {}),
            ...(l2ProxyRpc ? { l2ProxyRpc } : {}),
            ...(runtime.l1ExplorerUrl ? { l1Explorer: runtime.l1ExplorerUrl } : {}),
            ...(runtime.l2ExplorerUrl ? { l2Explorer: runtime.l2ExplorerUrl } : {}),
            ...(runtime.l2ExplorerApiUrl ? { l2ExplorerApi: runtime.l2ExplorerApiUrl } : {}),
            ...(runtime.l1ContractAddress ? { rollupsAddress: runtime.l1ContractAddress } : {}),
            ...(runtime.rollupId ? { rollupId: runtime.rollupId } : {}),
            ...(runtime.bridgeL1Address ? { l1Bridge: runtime.bridgeL1Address } : {}),
            ...(runtime.bridgeL2Address ? { l2Bridge: runtime.bridgeL2Address } : {}),
            ...(runtime.demoBridgeAddress ? {
              l1Bridge: runtime.demoBridgeAddress,
              l2Bridge: runtime.demoBridgeAddress,
            } : {}),
            ...(runtime.demoExecutorL1 ? { flashExecutorL1: runtime.demoExecutorL1 } : {}),
            ...(runtime.demoTokenAddress ? { flashTokenAddress: runtime.demoTokenAddress } : {}),
            ...(runtime.demoPoolAddress ? { flashPoolAddress: runtime.demoPoolAddress } : {}),
            ...(runtime.demoNftL2 ? { flashNftAddress: runtime.demoNftL2 } : {}),
            ...(runtime.demoExecutorL2 ? { flashExecutorL2: runtime.demoExecutorL2 } : {}),
            ...(runtime.demoWrappedTokenL2 ? { flashWrappedTokenL2: runtime.demoWrappedTokenL2 } : {}),
            ...(runtime.l2ContractAddress ? { ccmL2Address: runtime.l2ContractAddress } : {}),
            ...(runtime.reverseExecutorL2 ? { reverseExecutorL2: runtime.reverseExecutorL2 } : {}),
            ...(runtime.reverseNftL1 ? { reverseNftL1: runtime.reverseNftL1 } : {}),
            ...(runtime.reverseExecutorL1 ? { reverseExecutorL1: runtime.reverseExecutorL1 } : {}),
            ...(runtime.aggWeth ? { aggWeth: runtime.aggWeth } : {}),
            ...(runtime.aggUsdc ? { aggUsdc: runtime.aggUsdc } : {}),
            ...(runtime.aggL1Amm ? { aggL1Amm: runtime.aggL1Amm } : {}),
            ...(runtime.aggAggregator ? { aggAggregator: runtime.aggAggregator } : {}),
            ...(runtime.aggL2Executor ? { aggL2Executor: runtime.aggL2Executor } : {}),
            ...(runtime.aggL2Amm ? { aggL2Amm: runtime.aggL2Amm } : {}),
            ...(runtime.aggL2ExecutorProxy ? { aggL2ExecutorProxy: runtime.aggL2ExecutorProxy } : {}),
            ...(runtime.aggWrappedWethL2 ? { aggWrappedWethL2: runtime.aggWrappedWethL2 } : {}),
            ...(runtime.aggWrappedUsdcL2 ? { aggWrappedUsdcL2: runtime.aggWrappedUsdcL2 } : {}),
          });
        }
      } catch {
        /* Runtime config is unavailable; retain defaults and URL parameters. */
      }

      registerConfiguredContracts(config);

      // Auto-detect chain IDs from RPCs
      try {
        const l1ChainId = (await rpcCall(
          config.l1Rpc,
          "eth_chainId",
        )) as string;
        L1_CHAIN.chainId = l1ChainId;
        const dec = parseInt(l1ChainId, 16);
        L1_CHAIN.chainName = `EEZ L1 (${dec})`;
      } catch {
        /* keep defaults */
      }

      try {
        const l2ChainId = (await rpcCall(
          config.l2Rpc,
          "eth_chainId",
        )) as string;
        L2_CHAIN.chainId = l2ChainId;
        const dec = parseInt(l2ChainId, 16);
        L2_CHAIN.chainName = `EEZ L2 (${dec})`;
      } catch {
        /* keep defaults */
      }

      setLoaded(true);
    })();
  }, []);

  return loaded;
}
