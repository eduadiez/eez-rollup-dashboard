import type { Intent, Outcome, TreasuryConfig } from "../lib/treasury/client";
import { formatUSDC, formatPercentage } from "../lib/treasury/payments";
import { TreasuryPaymentFlow, TreasuryChainLink } from "./TreasuryPaymentFlow";
import type { TreasurySettlement } from "../lib/treasury/settlement";
import styles from "./TreasuryDemo.module.css";

export function TreasuryOutcomeDetails({ outcome, prefix = "", deployment, intent, settlement }: { outcome?: Outcome | null; prefix?: string; deployment: TreasuryConfig; intent?: Intent; settlement?: TreasurySettlement | null }) {
  const l1Name = deployment.l1.chainId === 10200 ? "Chiado" : "Ethereum";
  return <>
      {outcome?.kind === "settled" && outcome.contributions && intent?.payment && <TreasuryPaymentFlow deployment={deployment} intent={intent} outcome={outcome} settlement={settlement} sourceTestId={prefix ? undefined : "submitted-hash"} />}
      {outcome?.contributions?.rule && <p data-testid={`${prefix}rule-result`}>Paid {formatUSDC(BigInt(outcome.contributions.rule.amount))} USDC: {formatPercentage(BigInt(outcome.contributions.rule.bps))}% × ({formatUSDC(BigInt(outcome.contributions.rule.balanceL1))} {l1Name} + {formatUSDC(BigInt(outcome.contributions.rule.balanceL2))} EEZ-X) observed during execution.</p>}
      {outcome?.contributions && <p className={styles.copyStatus} data-testid={`${prefix}settled-funding`}>Paid {formatUSDC(BigInt(outcome.contributions.fromL1))} from {l1Name} + {formatUSDC(BigInt(outcome.contributions.fromL2))} from EEZ-X</p>}
      {outcome?.rollback && <div aria-label={`${prefix ? "Historical " : ""}Invoice rollback evidence`}>
        <ol><li>10 USDC released from the bridge on {l1Name}.</li><li>100 USDC transferred from the {l1Name} Safe.</li><li>Merchant rejected the closed invoice; both transfers reverted.</li></ol>
        <p>Canonical {l1Name} block {outcome.rollback.block}. The invoice is closed and unpaid.</p>
        <div className={styles.tableWrap}><table><thead><tr><th>Verified state</th><th>Before</th><th>After</th></tr></thead><tbody>
          {[[`${l1Name} Safe`, "balanceL1"], ["EEZ-X Safe", "balanceL2"], [`Recipient on ${l1Name}`, "recipientL1"], ["Recipient on EEZ-X", "recipientL2"], ["Bridge escrow", "escrow"], ["Wrapped supply", "supply"], ["Shared budget spent", "spent"]].map(([label, key]) => <tr key={key}><td>{label}</td><td>{formatUSDC(BigInt(outcome.rollback!.before[key!] as string))}</td><td>{formatUSDC(BigInt(outcome.rollback!.after[key!] as string))}</td></tr>)}
          {[[`${l1Name} allowance spent / nonce`, "allowanceL1"], ["EEZ-X allowance spent / nonce", "allowanceL2"]].map(([label, key]) => <tr key={key}><td>{label}</td>{[outcome.rollback!.before, outcome.rollback!.after].map((state, i) => <td key={i}>{formatUSDC(BigInt(state[key!]?.[1] ?? "0"))} / {state[key!]?.[4]}</td>)}</tr>)}
          <tr><td>EEZ-X Safe nonce</td><td>{outcome.rollback.before.safeNonce}</td><td>{outcome.rollback.after.safeNonce}</td></tr>
        </tbody></table></div>
        <p>Policy and alias balances, approvals and the {l1Name} Safe nonce are also unchanged.</p>
        <details><summary>Settlement evidence</summary><p>Payment post: <code>{outcome.rollback.postHash}</code> · <TreasuryChainLink deployment={deployment} chain="l1" value={outcome.rollback.postHash}>{l1Name} settlement transaction</TreasuryChainLink></p><p>Separate invoice closure: <code>{outcome.rollback.closeHash}</code></p><p>Successful token calls are visible in the reverted execution trace. No surviving transfer event is used as proof of rollback.</p></details>
      </div>}
  </>;
}
