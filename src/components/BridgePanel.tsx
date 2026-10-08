import { useState } from "react";
import { formatUnits } from "viem";
import type { BridgeState, BridgeDirection, BridgeAsset, TokenMeta } from "../hooks/useBridge";
import { config } from "../config";
import { GasLimitEditor } from "./GasLimitEditor";
import { TxLink } from "./TxLink";
import styles from "./BridgePanel.module.css";
import { BridgeTokenPicker } from "./BridgeTokenPicker";
import { NetworkIcon } from "./NetworkIcon";

interface Props {
  state: BridgeState;
  recentTokens: TokenMeta[];
  walletAddress: string | null;
  onSetDirection: (dir: BridgeDirection) => void;
  onSetAsset: (asset: BridgeAsset) => void;
  onSetAmount: (amt: string) => void;
  onSetDestination: (addr: string) => void;
  onSetTokenAddress: (addr: string) => void;
  onSetMax: () => void;
  onApprove: () => void;
  onBridge: () => void;
  onDismiss: () => void;
  onGasOverride: (gasHex: string | null) => void;
}

function NetworkBadge({ chain, role }: { chain: "l1" | "l2"; role: "Source" | "Destination" }) {
  const isL1 = chain === "l1";
  const name = isL1 ? config.l1NetworkName : config.rollupName;
  return (
    <div className={styles.chainBadge} role="group" aria-label={`${role} network`}>
      <NetworkIcon chain={chain} className={styles.chainIcon} />
      <div className={styles.chainName} title={name}>{name}</div>
      <div className={styles.chainRole}>{role}</div>
    </div>
  );
}

function DirectionSelector({
  direction,
  onSwap,
}: {
  direction: BridgeDirection;
  onSwap: () => void;
}) {
  const isL1Source = direction === "l1-to-l2";
  return (
    <div className={styles.directionBar}>
      <NetworkBadge chain={isL1Source ? "l1" : "l2"} role="Source" />
      <button className={styles.swapBtn} onClick={onSwap} title="Swap direction">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 16l-4-4 4-4" /><path d="M17 8l4 4-4 4" />
          <path d="M3 12h18" />
        </svg>
      </button>
      <NetworkBadge chain={isL1Source ? "l2" : "l1"} role="Destination" />
    </div>
  );
}

function AssetToggle({
  asset,
  onChange,
}: {
  asset: BridgeAsset;
  onChange: (a: BridgeAsset) => void;
}) {
  return (
    <div className={styles.assetToggle}>
      <button
        className={`${styles.assetBtn} ${asset === "eth" ? styles.assetActive : ""}`}
        aria-pressed={asset === "eth"}
        onClick={() => onChange("eth")}
      >
        ETH
      </button>
      <button
        className={`${styles.assetBtn} ${asset === "erc20" ? styles.assetActive : ""}`}
        aria-pressed={asset === "erc20"}
        onClick={() => onChange("erc20")}
      >
        ERC20
      </button>
    </div>
  );
}

function AmountSection({
  amount,
  sourceBalance,
  asset,
  tokenMeta,
  sourceBalanceRaw,
  onAmountChange,
  onAssetChange,
  onMax,
}: {
  amount: string;
  sourceBalance: string | null;
  asset: BridgeAsset;
  tokenMeta: TokenMeta | null;
  sourceBalanceRaw: bigint | null;
  onAmountChange: (amt: string) => void;
  onAssetChange: (asset: BridgeAsset) => void;
  onMax: () => void;
}) {
  const symbol = asset === "eth" ? "ETH" : (tokenMeta?.symbol || "tokens");
  const decimals = asset === "eth" ? 18 : (tokenMeta?.decimals ?? 18);

  // Validate amount vs balance
  let insufficientBalance = false;
  if (amount && sourceBalanceRaw !== null) {
    try {
      const parts = amount.split(".");
      const whole = parts[0] || "0";
      const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
      const rawAmount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
      if (rawAmount > sourceBalanceRaw) insufficientBalance = true;
    } catch { /* ignore */ }
  }

  return (
    <div className={styles.amountSection}>
      <div className={styles.amountHeader}>
        <label htmlFor="bridge-amount" className={styles.sectionTitle}>You send</label>
        <AssetToggle asset={asset} onChange={onAssetChange} />
      </div>
      <div className={styles.amountRow}>
        <input
          id="bridge-amount"
          aria-label="Bridge amount"
          inputMode="decimal"
          type="text"
          className={styles.input}
          value={amount}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder={`0.0 ${symbol}`}
        />
        <span className={styles.amountSymbol}>{symbol}</span>
      </div>
      <div className={styles.balanceRow}>
        <span>{sourceBalance !== null ? <>Balance: <span className={styles.balanceValue}>{sourceBalance} {symbol}</span></> : "Balance unavailable"}</span>
        <button className={styles.maxBtn} onClick={onMax} disabled={!sourceBalance}>MAX</button>
      </div>
      {insufficientBalance && (
        <div className={styles.validationHint}>Insufficient balance</div>
      )}
    </div>
  );
}

function ReceivePreview({
  rawAmount,
  decimals,
  asset,
  tokenMeta,
  direction,
}: {
  rawAmount: bigint;
  decimals: number;
  asset: BridgeAsset;
  tokenMeta: TokenMeta | null;
  direction: BridgeDirection;
}) {
  if (rawAmount <= 0n) return null;
  const symbol = asset === "eth" ? "ETH" : (tokenMeta?.symbol || "tokens");
  const destChain = direction === "l1-to-l2" ? config.rollupName : config.l1NetworkName;

  return (
    <div className={styles.receivePreview}>
      <div>
        <div className={styles.sectionTitle}>You receive</div>
        <div className={styles.receiveChain}>on {destChain}</div>
      </div>
      <div className={styles.receiveAmount}>{formatUnits(rawAmount, decimals)} {symbol}</div>
    </div>
  );
}

function PhaseIndicator({ phase }: { phase: string }) {
  if (phase === "idle" || phase === "confirmed") return null;

  const messages: Record<string, string> = {
    approving: "Sending approval transaction...",
    "approve-pending": "Waiting for approval confirmation...",
    sending: "Sending bridge transaction...",
    "tx-pending": "Waiting for confirmation...",
  };

  if (phase === "failed") return null; // error bar handles this

  return (
    <div className={styles.phaseBar}>
      <span className={styles.spinner} />
      <span>{messages[phase] || "Processing..."}</span>
    </div>
  );
}

export function BridgePanel({
  state,
  recentTokens,
  walletAddress,
  onSetDirection,
  onSetAsset,
  onSetAmount,
  onSetDestination,
  onSetTokenAddress,
  onSetMax,
  onApprove,
  onBridge,
  onDismiss,
  onGasOverride,
}: Props) {
  const [editingRecipient, setEditingRecipient] = useState(false);
  const {
    phase, direction, asset, amount, tokenAddress, tokenMeta,
    txHash, error, sourceBalance, sourceBalanceRaw, allowance,
    l1BridgeReady, l2BridgeReady, gas, destinationAddress, tokenNeedsApproval, tokenReadError,
  } = state;

  const busy = !["idle", "confirmed", "failed"].includes(phase);
  const sourceBridgeReady = direction === "l1-to-l2" ? l1BridgeReady : l2BridgeReady;
  const sourceBridgeError = direction === "l1-to-l2" ? state.l1BridgeError : state.l2BridgeError;
  const bridgeConfigured = direction === "l1-to-l2" ? !!config.l1Bridge : !!config.l2Bridge;

  // Determine if approval is needed
  const decimals = asset === "eth" ? 18 : (tokenMeta?.decimals ?? 18);
  let rawAmount = 0n;
  if (amount) {
    try {
      const parts = amount.split(".");
      const whole = parts[0] || "0";
      const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
      rawAmount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
    } catch { /* ignore */ }
  }
  const needsApproval = asset === "erc20" && tokenNeedsApproval === true && allowance !== null && rawAmount > 0n && allowance < rawAmount;

  // Insufficient balance check
  let insufficientBalance = false;
  if (amount && sourceBalanceRaw !== null && rawAmount > 0n) {
    insufficientBalance = rawAmount > sourceBalanceRaw;
  }

  const canBridge =
    !busy &&
    sourceBridgeReady &&
    (gas.status === "estimated" || gas.status === "unsupported" && !!state.gasOverrideHex) &&
    amount &&
    rawAmount > 0n &&
    !insufficientBalance &&
    !needsApproval &&
    (asset === "eth" || tokenNeedsApproval !== null && sourceBalanceRaw !== null && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress));

  const disabledReason = !walletAddress ? "Connect your wallet to bridge." :
    !canBridge && !busy && sourceBridgeReady && rawAmount > 0n ?
      asset === "erc20" && tokenReadError ? `Unable to check the token: ${tokenReadError}. Retrying…` :
      asset === "erc20" && (tokenNeedsApproval === null || sourceBalanceRaw === null) ? "Checking token balance and approval…" :
      insufficientBalance ? `Insufficient ${asset === "eth" ? "ETH" : tokenMeta?.symbol || "token"} balance on ${direction === "l1-to-l2" ? "L1" : "L2"}.` :
      needsApproval ? `Approve ${tokenMeta?.symbol || "the token"} before bridging.` :
      gas.status === "idle" || gas.status === "estimating" ? "Waiting for a Composer gas estimate…" : null : null;

  const actionLabel = asset === "eth" ? "Transfer ETH" : `Transfer ${tokenMeta?.symbol || "Tokens"}`;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Transfer</span>
      </div>

      {/* Warning: bridge not deployed */}
      {!bridgeConfigured && (
        <div className={styles.warningBar}>
          Bridge contracts are not configured for this network.
        </div>
      )}
      {bridgeConfigured && sourceBridgeReady === null && (
        <div className={styles.phaseBar} role="status">
          {sourceBridgeError
            ? `Unable to check the bridge on ${direction === "l1-to-l2" ? "L1" : "L2"}. Retrying…`
            : `Checking bridge on ${direction === "l1-to-l2" ? "L1" : "L2"}…`}
        </div>
      )}
      {bridgeConfigured && sourceBridgeReady === false && (
        <div className={styles.warningBar}>
          Bridge contract not deployed or not initialized on {direction === "l1-to-l2" ? "L1" : "L2"}.
        </div>
      )}

      {/* Direction selector */}
      <DirectionSelector
        direction={direction}
        onSwap={() =>
          onSetDirection(direction === "l1-to-l2" ? "l2-to-l1" : "l1-to-l2")
        }
      />

      {/* Token address input (ERC20 only) */}
      {asset === "erc20" && (
        <BridgeTokenPicker
          direction={direction}
          walletAddress={walletAddress}
          disabled={busy}
          tokenAddress={tokenAddress}
          tokenMeta={tokenMeta}
          recentTokens={recentTokens}
          onAddressChange={onSetTokenAddress}
        />
      )}

      {/* Amount */}
      <AmountSection
        amount={amount}
        sourceBalance={sourceBalance}
        asset={asset}
        tokenMeta={tokenMeta}
        sourceBalanceRaw={sourceBalanceRaw}
        onAmountChange={onSetAmount}
        onAssetChange={onSetAsset}
        onMax={onSetMax}
      />

      {/* Receive preview */}
      <ReceivePreview
        rawAmount={rawAmount}
        decimals={decimals}
        asset={asset}
        tokenMeta={tokenMeta}
        direction={direction}
      />

      <div className={styles.recipientSection}>
        <div className={styles.recipientHeader}>
          <div>
            <div className={styles.sectionTitle}>Recipient</div>
            {!editingRecipient && !destinationAddress && <div className={styles.recipientWallet}>
              Your wallet <span title={walletAddress || undefined}>{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Connect a wallet"}</span>
            </div>}
          </div>
          <button className={styles.recipientToggle} disabled={busy}
            aria-expanded={editingRecipient || !!destinationAddress} aria-controls="bridge-recipient"
            onClick={() => {
              if (editingRecipient || destinationAddress) { onSetDestination(""); setEditingRecipient(false); }
              else setEditingRecipient(true);
            }}>
            {editingRecipient || destinationAddress ? "Use my wallet" : "Change recipient"}
          </button>
        </div>
        {(editingRecipient || destinationAddress) && <div id="bridge-recipient">
          <input type="text" className={styles.input} aria-label="Recipient address"
            value={destinationAddress} onChange={(e) => onSetDestination(e.target.value)}
            placeholder={walletAddress || "0x... (defaults to your wallet)"} disabled={busy} />
          <div className={styles.sectionHint}>Leave empty to use your connected wallet.</div>
        </div>}
      </div>

      {/* Phase indicator */}
      <PhaseIndicator phase={phase} />

      {/* Confirmed */}
      {phase === "confirmed" && txHash && (
        <div className={`${styles.phaseBar} ${styles.phaseOk}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          <span>Bridge transaction confirmed</span>
        </div>
      )}

      {/* Error bar */}
      {phase === "failed" && error && (
        <div className={styles.errorBar}>
          {error}
          <button className="btn btn-sm btn-ghost" onClick={onDismiss}>Dismiss</button>
        </div>
      )}

      {/* TX hash */}
      {txHash && (
        <div className={styles.txHashRow}>
          <span className={styles.txLabel}>TX</span>
          <TxLink
            hash={txHash}
            chain={direction === "l1-to-l2" ? "l1" : "l2"}
            className={styles.txValue}
          />
        </div>
      )}

      {/* Gas settings are already collapsed; keep estimation errors visible. */}
      {gas.status === "unsupported" && gas.errorMessage && <div className={styles.validationHint} role="status">{gas.errorMessage}</div>}
      {gas.status === "error" && gas.errorMessage && (
        <div className={styles.errorBar} role="alert">Gas estimation failed: {gas.errorMessage}</div>
      )}
      {amount && rawAmount > 0n && sourceBridgeReady && (
        <GasLimitEditor
          estimatedGas={gas.estimate}
          estimatedGasWithBuffer={gas.gasLimit}
          estimating={gas.status === "estimating"}
          estimationMethod={gas.method}
          onGasOverride={onGasOverride}
          disabled={busy}
        />
      )}

      {/* Approval button (ERC20 step 1) */}
      {needsApproval && !busy && (
        <>
          <div className={styles.approveNote}>Step 1 of 2 — Approve token spending</div>
          <button
            className="btn btn-solid btn-accent btn-block"
            onClick={onApprove}
            style={{ marginBottom: 8 }}
          >
            Approve {tokenMeta?.symbol || "Token"}
          </button>
        </>
      )}

      {disabledReason && <div className={styles.validationHint} role="status">{disabledReason}</div>}

      {/* Bridge button */}
      <button
        className="btn btn-solid btn-green btn-block"
        onClick={onBridge}
        disabled={!canBridge}
      >
        {busy ? (
          <><span className="btn-spinner" /> Transferring...</>
        ) : (
          actionLabel
        )}
      </button>


    </div>
  );
}
