import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BridgeAsset, BridgeDirection } from "../hooks/useBridge";
import { config, L1_CHAIN, L2_CHAIN } from "../config";
import { NetworkIcon } from "./NetworkIcon";
import styles from "./BridgeAssetSwap.module.css";

interface Props {
  direction: BridgeDirection;
  asset: BridgeAsset;
  amount: string;
  received: string;
  symbol: string | null;
  balance: string | null;
  connected: boolean;
  disabled: boolean;
  maxPending: boolean;
  maxError: string | null;
  recipient: ReactNode;
  onDirectionChange: (direction: BridgeDirection) => void;
  onAssetChange: (asset: BridgeAsset) => void;
  onAmountChange: (amount: string) => void;
  onMax: () => void;
}

/** Original dashboard control; uses the existing bridge state and design tokens. */
export function BridgeAssetSwap(props: Props) {
  const [picker, setPicker] = useState<"l1" | "l2" | null>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (picker) firstChoice.current?.focus(); }, [picker]);
  useEffect(() => { setPicker(null); }, [props.direction, props.disabled]);
  const closePicker = () => { setPicker(null); trigger.current?.focus(); };
  const source = props.direction === "l1-to-l2" ? "l1" : "l2";

  return <div className={styles.control} role="region" aria-label="Bridge transfer">
    {(["l1", "l2"] as const).map(chain => {
      const from = chain === source;
      const name = chain === "l1" ? config.l1NetworkName : config.rollupName;
      const native = (chain === "l1" ? L1_CHAIN : L2_CHAIN).nativeCurrency.symbol;
      const symbol = props.asset === "eth" ? native : props.symbol || "ERC20";
      return <div key={chain} className={styles.networkPanel} data-chain={chain} data-source={from}
        role="group" aria-label={from ? "Source network" : "Destination network"}
        onKeyDown={event => { if (event.key === "Escape" && picker === chain) { event.preventDefault(); event.stopPropagation(); closePicker(); } }}>
        <div className={styles.panelHeader}>
          <span className={styles.role}>{from ? "From" : "To"}</span>
          <div className={styles.network}><NetworkIcon chain={chain} decorative className={styles.logo} /><span>{name}</span></div>
        </div>
        <div className={styles.amountRow} data-long={(from ? props.amount : props.received).length > 14}>
          {from ? <input id="bridge-amount" aria-label="Bridge amount" inputMode="decimal" type="text"
            spellCheck={false} autoComplete="off" className={styles.amount} value={props.amount}
            onChange={event => props.onAmountChange(event.target.value)} placeholder="0.0" disabled={props.disabled} /> :
            <output className={styles.received} aria-label="Destination amount" title="Calculated from the From amount">{props.received || "—"}</output>}
          <button className={styles.assetPill} type="button" disabled={props.disabled}
            aria-label={`Choose bridge asset on ${name}`} aria-expanded={picker === chain}
            aria-controls={`bridge-asset-picker-${chain}`}
            onClick={event => { trigger.current = event.currentTarget; setPicker(picker === chain ? null : chain); }}>
            <span>{symbol}</span><span aria-hidden="true">⌄</span>
          </button>
        </div>
        {picker === chain && <div className={styles.assetPicker} id={`bridge-asset-picker-${chain}`} role="group" aria-label="Bridge asset choices">
          <button ref={firstChoice} type="button" disabled={props.disabled} aria-pressed={props.asset === "eth"}
            onClick={() => { if (props.asset !== "eth") props.onAssetChange("eth"); closePicker(); }}>{native}</button>
          <button type="button" disabled={props.disabled} aria-pressed={props.asset === "erc20"}
            onClick={() => { if (props.asset !== "erc20") props.onAssetChange("erc20"); closePicker(); }}>ERC20</button>
          <p>One asset across both networks. Choose an ERC20 token below.</p>
        </div>}
        {from ? <div className={styles.balanceRow}>
          <span>{props.balance !== null ? <>Balance: <strong>{props.balance} {symbol}</strong></> :
            !props.connected ? "Connect a wallet to view your balance" : props.asset === "erc20" && !props.symbol ? "Choose a token below" : "Loading balance…"}</span>
          <button className={styles.max} type="button" disabled={props.disabled || props.maxPending || !props.connected || props.balance === null}
            title={props.asset === "eth" ? "Use your balance minus the quoted gas reserve" : "Use your full token balance"}
            onClick={props.onMax}>{props.maxPending ? "Calculating…" : "MAX"}</button>
        </div> : props.recipient}
        {from && props.maxError && <p className={styles.warning} role="status">{props.maxError}</p>}
        {chain === "l1" && <button className={styles.flip} type="button" title="Swap direction"
          aria-label={`Swap source and destination: ${source === "l1" ? config.rollupName : config.l1NetworkName} becomes the source`}
          disabled={props.disabled} onClick={() => props.onDirectionChange(props.direction === "l1-to-l2" ? "l2-to-l1" : "l1-to-l2")}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4" /></svg>
        </button>}
      </div>;
    })}
  </div>;
}
