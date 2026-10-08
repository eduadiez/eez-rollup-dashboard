import { useState } from "react";
import { formatUnits } from "viem";
import type { BridgeDirection, TokenMeta } from "../hooks/useBridge";
import { useBridgeTokens } from "../hooks/useBridgeTokens";
import styles from "./BridgeTokenPicker.module.css";

interface Props {
  direction: BridgeDirection;
  walletAddress: string | null;
  tokenAddress: string;
  tokenMeta: TokenMeta | null;
  recentTokens: TokenMeta[];
  disabled: boolean;
  onAddressChange: (address: string) => void;
}

export function BridgeTokenPicker({ direction, walletAddress, tokenAddress, tokenMeta, recentTokens, disabled, onAddressChange }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"wallet" | "known" | "recent">(walletAddress ? "wallet" : "known");
  const [search, setSearch] = useState("");
  const catalog = useBridgeTokens(open, direction, walletAddress, recentTokens);
  const query = search.trim().toLowerCase();
  const tokens = catalog.tokens.filter(token => (filter === "wallet" ? (token.balance ?? 0n) > 0n : filter === "known" ? token.known : token.recent)
    && [token.symbol, token.name, token.address].some(value => value.toLowerCase().includes(query)))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const valid = !tokenAddress || /^0x[0-9a-f]{40}$/i.test(tokenAddress);

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <label className={styles.label} htmlFor="bridge-token-address">Token</label>
        <button className={styles.browse} disabled={disabled} aria-expanded={open} aria-controls="bridge-token-picker"
          onClick={() => setOpen(!open)}>{open ? "Close tokens" : "Browse tokens"}</button>
      </div>
      <input id="bridge-token-address" className={styles.input} aria-label="Token address" type="text"
        value={tokenAddress} onChange={e => onAddressChange(e.target.value)} disabled={disabled}
        placeholder="0x... (ERC20 token address)" />
      {!valid && <p className={styles.error}>Enter a valid contract address.</p>}
      {tokenMeta && <p className={styles.selected}><strong>{tokenMeta.symbol}</strong> · {tokenMeta.name}</p>}
      {open && <div className={styles.picker} id="bridge-token-picker">
        <input className={styles.search} aria-label="Search tokens" placeholder="Search name, symbol, or address"
          value={search} onChange={e => setSearch(e.target.value)} disabled={disabled} />
        <div className={styles.filters} role="group" aria-label="Token sources">
          {(["wallet", "known", "recent"] as const).map(value => <button key={value}
            className={`${styles.filter} ${filter === value ? styles.active : ""}`} aria-pressed={filter === value}
            disabled={disabled} onClick={() => setFilter(value)}>{value === "wallet" ? "Your tokens" : value === "known" ? "Known" : "Recent"}</button>)}
        </div>
        {catalog.loading ? <p className={styles.hint} role="status">Loading tokens…</p> : <>
          {filter === "wallet" && !walletAddress && <p className={styles.hint}>Connect your wallet to see token balances.</p>}
          {filter === "wallet" && walletAddress && !catalog.walletComplete && <p className={styles.hint}>Showing known and recent tokens with a balance. Other tokens may not appear.</p>}
          {catalog.listUnavailable && filter === "known" && <p className={styles.hint}>The configured list is unavailable. Local tokens and address entry are still available.</p>}
          {tokens.length === 0 ? <p className={styles.empty}>No matching tokens. Enter a token address above.</p> :
            <ul className={styles.tokens}>
              {tokens.slice(0, 100).map(token => <li key={token.address.toLowerCase()}>
                <button className={styles.token} disabled={disabled} aria-label={`Select ${token.symbol} ${token.address}`}
                  onClick={() => { onAddressChange(token.address); setOpen(false); setSearch(""); }}>
                  <span className={styles.tokenText}><strong>{token.symbol}</strong><span>{token.name}</span><code>{token.address.slice(0, 6)}…{token.address.slice(-4)}</code></span>
                  {token.balance !== undefined && <span className={styles.balance} title={formatUnits(token.balance, token.decimals)}>
                    {formatUnits(token.balance, token.decimals)}
                  </span>}
                </button>
              </li>)}
            </ul>}
          {tokens.length > 100 && <p className={styles.hint}>Showing 100 matches. Refine your search to find another token.</p>}
        </>}
      </div>}
    </div>
  );
}
