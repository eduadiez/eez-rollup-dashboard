import { useEffect, useState } from "react";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { rpcCall } from "../rpc";
import type { BridgeDirection, TokenMeta } from "./useBridge";
import popular from "../lib/popularTokens.json";

export interface BridgeToken extends TokenMeta {
  chainId: number;
  known: boolean;
  recent: boolean;
  balance?: bigint;
}

interface CatalogState {
  scope: string;
  tokens: BridgeToken[];
  loading: boolean;
  walletComplete: boolean;
  listUnavailable: boolean;
}

function tokenMeta(value: unknown, chainId: number): TokenMeta | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (t.chainId !== chainId || typeof t.address !== "string" || !/^0x[0-9a-f]{40}$/i.test(t.address)
    || typeof t.name !== "string" || typeof t.symbol !== "string"
    || !Number.isInteger(t.decimals) || Number(t.decimals) < 0 || Number(t.decimals) > 77) return null;
  return { address: t.address, name: t.name, symbol: t.symbol, decimals: Number(t.decimals), chainId };
}

/** Discovery is read-only; selecting a token still uses the bridge's on-chain checks. */
export function useBridgeTokens(open: boolean, direction: BridgeDirection, wallet: string | null, recent: TokenMeta[]) {
  const chainId = Number(BigInt(direction === "l1-to-l2" ? L1_CHAIN.chainId : L2_CHAIN.chainId));
  const rpc = direction === "l1-to-l2" ? config.l1Rpc : config.l2Rpc;
  const explorer = direction === "l1-to-l2" ? config.l1ExplorerApi : config.l2ExplorerApi;
  const listUrl = config.tokenListUrl;
  const scope = `${chainId}:${rpc}:${wallet?.toLowerCase() || ""}:${explorer}:${listUrl}`;
  const [state, setState] = useState<CatalogState>({ scope: "", tokens: [], loading: false, walletComplete: false, listUnavailable: false });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    const signal = controller.signal;
    let cancelled = false;
    setState({ scope, tokens: [], loading: true, walletComplete: false, listUnavailable: false });

    (async () => {
      const tokens = new Map<string, BridgeToken>();
      const add = (meta: TokenMeta, flags: Partial<BridgeToken>) => {
        const key = meta.address.toLowerCase();
        const existing = tokens.get(key);
        tokens.set(key, { ...meta, chainId, known: false, recent: false, ...existing, ...flags });
      };
      for (const entry of popular.tokens) {
        const meta = tokenMeta(entry, chainId);
        if (meta) add(meta, { known: true });
      }
      for (const entry of recent) {
        const meta = tokenMeta(entry, chainId);
        if (meta) add(meta, { recent: true });
      }
      let listUnavailable = false;
      let walletComplete = false;

      await Promise.allSettled([
        (async () => {
          if (!listUrl) return;
          try {
            const response = await fetch(listUrl, { signal });
            if (!response.ok) throw new Error("Token list unavailable");
            const data = await response.json() as { tokens?: unknown[] };
            if (!Array.isArray(data.tokens)) throw new Error("Invalid token list");
            for (const entry of data.tokens.slice(0, 10000)) {
              const meta = tokenMeta(entry, chainId);
              if (meta) add(meta, { known: true });
            }
          } catch { listUnavailable = true; }
        })(),
        (async () => {
          if (!wallet || !explorer) return;
          try {
            const response = await fetch(`${explorer.replace(/\/$/, "")}/api/v2/addresses/${wallet}/token-balances`, { signal });
            if (!response.ok) throw new Error("Wallet tokens unavailable");
            const data: unknown = await response.json();
            if (!Array.isArray(data)) throw new Error("Invalid wallet token list");
            for (const entry of data) {
              const token = entry?.token;
              if (token?.type !== "ERC-20" || token.decimals === null || token.decimals === undefined || !/^\d+$/.test(String(entry.value))) continue;
              const meta = tokenMeta({ chainId, address: token.address_hash, name: token.name, symbol: token.symbol, decimals: Number(token.decimals) }, chainId);
              if (meta && BigInt(entry.value) > 0n) add(meta, { balance: BigInt(entry.value) });
            }
            walletComplete = true;
          } catch { /* Known/recent tokens and address entry remain usable. */ }
        })(),
      ]);

      // Check a bounded set on the source RPC, including familiar tokens when
      // the explorer is unavailable. Larger lists remain searchable without a
      // balance request for every entry.
      if (wallet) {
        const candidates = [...tokens.values()].filter(t => t.balance === undefined)
          .sort((a, b) => Number(b.recent) - Number(a.recent)).slice(0, 24);
        for (let start = 0; start < candidates.length && !signal.aborted; start += 6) {
          await Promise.allSettled(candidates.slice(start, start + 6).map(async token => {
            try {
              const value = await rpcCall(rpc, "eth_call", [{ to: token.address, data: "0x70a08231" + wallet.slice(2).padStart(64, "0") }, "latest"], signal);
              if (typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value)) token.balance = BigInt(value);
            } catch { /* No balance evidence for this candidate. */ }
          }));
        }
      }
      if (!cancelled) setState({ scope, tokens: [...tokens.values()], loading: false, walletComplete, listUnavailable });
      window.clearTimeout(timeout);
    })();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [open, scope, chainId, rpc, explorer, listUrl, wallet, recent]);

  // Do not render a previous account's or chain's tokens while its new request starts.
  return state.scope === scope ? state : { scope, tokens: [], loading: open, walletComplete: false, listUnavailable: false };
}
