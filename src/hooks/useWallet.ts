import { useCallback, useEffect, useRef, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { rpcCall } from "../rpc";
import type { WalletState } from "../types";
import { useWalletProviders } from "./useWalletProviders";
import { useComposerDetection } from "./useComposerDetection";

type Logger = (msg: string, type?: "ok" | "err" | "info") => void;

export function useWallet(log: Logger, configLoaded = false) {
  const [state, setState] = useState<WalletState>({
    address: null,
    chainId: null,
    l1Balance: null,
    l2Balance: null,
    isConnected: false,
  });

  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedProviderRef = useRef<EthereumProvider | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<EthereumProvider | null>(null);
  const [walletRevision, setWalletRevision] = useState(0);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const walletOptions = useWalletProviders();
  const composer = useComposerDetection(selectedProvider, state.address, state.chainId, configLoaded && state.isConnected, walletRevision);

  const hasProvider = walletOptions.length > 0;

  useEffect(() => {
    const timer = setTimeout(() => setDiscoveryReady(true), 300);
    return () => clearTimeout(timer);
  }, []);

  const refreshBalance = useCallback(async (address: string) => {
    // Fetch L1 and L2 balances in parallel
    const [l1Result, l2Result] = await Promise.allSettled([
      rpcCall(config.l1Rpc, "eth_getBalance", [address, "latest"]),
      rpcCall(config.l2Rpc, "eth_getBalance", [address, "latest"]),
    ]);

    // Use BigInt for precision — parseInt + /1e18 loses precision for
    // values above ~2^53 wei (which includes the CCM's 1M ETH genesis pre-mint).
    const formatEth = (hex: string): string => {
      try {
        const wei = BigInt(hex);
        const ONE_ETH = 10n ** 18n;
        const whole = wei / ONE_ETH;
        // Cap unreasonable balances (e.g. CCM with 1M ETH pre-mint)
        if (whole > 10n ** 9n) return "∞";
        const frac = wei % ONE_ETH;
        const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
        return `${whole.toString()}.${fracStr}`;
      } catch {
        return "—";
      }
    };

    const l1Bal = l1Result.status === "fulfilled" ? formatEth(l1Result.value as string) : null;
    const l2Bal = l2Result.status === "fulfilled" ? formatEth(l2Result.value as string) : null;

    setState((s) => ({ ...s, l1Balance: l1Bal, l2Balance: l2Bal }));
  }, []);

  const connect = useCallback(async (providerId?: string) => {
    if (!hasProvider) {
      log("No wallet detected — install Rabby or MetaMask to connect", "err");
      return;
    }
    const choice = providerId
      ? walletOptions.find((item) => item.id === providerId)
      : walletOptions.length === 1 ? walletOptions[0] : undefined;
    if (!choice) {
      log("Choose a wallet to connect", "err");
      return;
    }
    try {
      const accounts = (await choice.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const addr = accounts[0];
      if (!addr) return;

      const chainId = (await choice.provider.request({
        method: "eth_chainId",
      })) as string;

      // Keep the current wallet connected if the new wallet rejects either request.
      selectedProviderRef.current = choice.provider;
      setSelectedProvider(choice.provider);
      setWalletRevision(revision => revision + 1);
      setState({
        address: addr,
        chainId,
        l1Balance: null,
        l2Balance: null,
        isConnected: true,
      });
      localStorage.setItem("walletConnected", "true");
      localStorage.setItem("walletProvider", choice.storageKey);
      log(
        `${choice.name} connected: ${addr.slice(0, 8)}...${addr.slice(-6)}`,
        "info",
      );
      refreshBalance(addr);
    } catch (e) {
      log(`Wallet connect failed: ${(e as Error).message}`, "err");
    }
  }, [hasProvider, walletOptions, log, refreshBalance]);

  const disconnect = useCallback(() => {
    selectedProviderRef.current = null;
    setSelectedProvider(null);
    setState({
      address: null,
      chainId: null,
      l1Balance: null,
      l2Balance: null,
      isConnected: false,
    });
    localStorage.removeItem("walletConnected");
    localStorage.removeItem("walletProvider");
    log("Wallet disconnected", "info");
  }, [log]);

  const switchChain = useCallback(
    async (chainId: string, chainDef: typeof L1_CHAIN | typeof L2_CHAIN) => {
      if (!state.isConnected) {
        log("Connect wallet first", "err");
        return false;
      }
      const provider = selectedProviderRef.current;
      if (!provider) throw new Error("Connect wallet first");
      try {
        // Try adding the chain first (works with Rabby, MetaMask, and others).
        // If the chain already exists, most wallets silently ignore this.
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [chainDef],
        });
      } catch {
        // Some wallets reject addEthereumChain for already-known chains — ignore
      }
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId }],
        });
        setState(s => ({ ...s, chainId }));
        return true;
      } catch (e) {
        log(`Switch chain failed: ${(e as Error).message}`, "err");
        return false;
      }
    },
    [state.isConnected, log],
  );

  const switchToL1 = useCallback(
    () => switchChain(L1_CHAIN.chainId, L1_CHAIN),
    [switchChain],
  );
  const switchToL2 = useCallback(
    () => switchChain(L2_CHAIN.chainId, L2_CHAIN),
    [switchChain],
  );

  /**
   * Ensure the wallet is on the right chain, auto-switching if needed.
   * Rabby and MetaMask both support wallet_addEthereumChain + wallet_switchEthereumChain.
   */
  const ensureChain = useCallback(
    async (chainDef: typeof L1_CHAIN | typeof L2_CHAIN) => {
      const provider = selectedProviderRef.current;
      if (!provider) throw new Error("Connect wallet first");
      if (stateRef.current.chainId === chainDef.chainId) return;
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [chainDef],
        });
      } catch {
        // Chain may already exist — ignore
      }
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainDef.chainId }],
      });
    },
    [],
  );

  /**
   * All transactions use the selected wallet and Composer-backed chain definition.
   * Existing wallet network entries must use the Composer RPC URL; adding a known
   * chain does not guarantee that the wallet updates its saved RPC.
   */
  const sendOnChain = useCallback(async (
    chain: typeof L1_CHAIN | typeof L2_CHAIN,
    txParams: Record<string, string>,
  ): Promise<string> => {
    if (!stateRef.current.isConnected) throw new Error("Connect wallet to send transactions");
    await ensureChain(chain);
    const provider = selectedProviderRef.current;
    if (!provider) throw new Error("Connect wallet first");
    const gas = txParams.gas ?? txParams.gasLimit;
    return await provider.request({
      method: "eth_sendTransaction",
      params: [{
        ...txParams,
        from: stateRef.current.address!,
        ...(gas ? { gas, gasLimit: gas } : {}),
      }],
    }) as string;
  }, [ensureChain]);

  const sendTx = useCallback((params: Record<string, string>) => sendOnChain(L2_CHAIN, params), [sendOnChain]);
  const sendL1Tx = useCallback((params: Record<string, string>) => sendOnChain(L1_CHAIN, params), [sendOnChain]);

  // Auto-reconnect on mount
  useEffect(() => {
    if (
      !configLoaded || !discoveryReady || !hasProvider || stateRef.current.isConnected ||
      localStorage.getItem("walletConnected") !== "true"
    ) return;
    const savedKey = localStorage.getItem("walletProvider");
    const candidates = savedKey
      ? walletOptions.filter((item) => item.storageKey === savedKey)
      : walletOptions;
    if (candidates.length === 1) {
      const choice = candidates[0]!;
      (async () => {
        try {
          const accounts = (await choice.provider.request({
            method: "eth_accounts",
          })) as string[];
          const addr = accounts[0];
          if (!addr) return;

          const chainId = (await choice.provider.request({
            method: "eth_chainId",
          })) as string;

          selectedProviderRef.current = choice.provider;
          setSelectedProvider(choice.provider);
          setState({
            address: addr,
            chainId,
            l1Balance: null,
            l2Balance: null,
            isConnected: true,
          });
          refreshBalance(addr);
        } catch {
          /* silent */
        }
      })();
    }
  }, [configLoaded, discoveryReady, hasProvider, walletOptions, refreshBalance]);

  // Listen for account/chain changes
  useEffect(() => {
    if (!selectedProvider) return;
    const eth = selectedProvider;

    const onAccountsChanged = ((...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts.length === 0) {
        disconnect();
      } else {
        setWalletRevision(revision => revision + 1);
        setState((s) => ({ ...s, address: accounts[0]! }));
        refreshBalance(accounts[0]!);
      }
    }) as (...args: unknown[]) => void;

    const onChainChanged = ((...args: unknown[]) => {
      const chainId = args[0] as string;
      setWalletRevision(revision => revision + 1);
      setState((s) => ({ ...s, chainId }));
    }) as (...args: unknown[]) => void;

    eth.on("accountsChanged", onAccountsChanged);
    eth.on("chainChanged", onChainChanged);
    return () => {
      eth.removeListener("accountsChanged", onAccountsChanged);
      eth.removeListener("chainChanged", onChainChanged);
    };
  }, [selectedProvider, disconnect, refreshBalance]);

  // Periodic balance refresh
  useEffect(() => {
    if (!state.isConnected || !state.address) return;
    const interval = setInterval(() => refreshBalance(state.address!), 10000);
    return () => clearInterval(interval);
  }, [state.isConnected, state.address, refreshBalance]);

  return {
    ...state,
    ...composer,
    hasProvider,
    walletName: walletOptions.find((option) => option.provider === selectedProvider)?.name
      ?? null,
    walletOptions: walletOptions.map(({ id, name }) => ({ id, name })),
    connect,
    disconnect,
    switchToL1,
    switchToL2,
    sendTx,
    sendL2ProxyTx: sendTx,
    sendL1Tx,
    sendL1ProxyTx: sendL1Tx,
  };
}
