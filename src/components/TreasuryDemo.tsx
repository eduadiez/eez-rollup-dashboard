import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import styles from "./TreasuryDemo.module.css";

type Chain = "l1" | "l2";
type Phase = "editing" | "approving" | "pending" | "settled";
type Ledger = { balances: Record<Chain, bigint>; spent: Record<Chain, bigint>; globalSpent: bigint };
type Payment = { recipient: string; destination: Chain; amount: bigint; from: Record<Chain, bigint> };
const unit = 1_000_000n;
const chainLimit = 100n * unit;
const globalLimit = 150n * unit;
const names: Record<Chain, string> = { l1: "Ethereum", l2: "EEZ-X" };
const chains: Chain[] = ["l1", "l2"];
const money = (value: bigint) => `${formatUnits(value, 6)} USDC`;
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const initialLedger = (): Ledger => ({ balances: { l1: 300n * unit, l2: 150n * unit }, spent: { l1: 0n, l2: 0n }, globalSpent: 0n });

// All state is illustrative and stays inside this example. Live wallet/RPC
// adapters will replace this simulation when the treasury contracts are ready.
export function TreasuryDemo() {
  const [ledger, setLedger] = useState(initialLedger);
  const [recipient, setRecipient] = useState("Demo merchant");
  const [amountInput, setAmountInput] = useState("40");
  const [destination, setDestination] = useState<Chain>("l2");
  const [phase, setPhase] = useState<Phase>("editing");
  const [review, setReview] = useState<Payment | null>(null);
  const [approvals, setApprovals] = useState<string[]>([]);
  const [history, setHistory] = useState<Payment[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);

  const validAmount = /^\d{1,12}(\.\d{1,6})?$/.test(amountInput);
  const amount = validAmount ? parseUnits(amountInput, 6) : 0n;
  const remaining = globalLimit - ledger.globalSpent;
  const capacity = {
    l1: minimum(ledger.balances.l1, chainLimit - ledger.spent.l1),
    l2: minimum(ledger.balances.l2, chainLimit - ledger.spent.l2),
  };
  const remote = destination === "l1" ? "l2" : "l1";
  const localAmount = minimum(amount, capacity[destination]);
  const from: Record<Chain, bigint> = { l1: 0n, l2: 0n };
  from[destination] = localAmount;
  from[remote] = amount - localAmount;
  let error = "";
  if (!recipient.trim()) error = "Enter a recipient for this preview.";
  else if (!validAmount || amount <= 0n) error = "Enter a positive USDC amount with up to 6 decimal places.";
  else if (amount > remaining) error = remaining === 0n
    ? `Shared budget exhausted. ${names[destination]} still has ${money(chainLimit - ledger.spent[destination])} of allowance remaining.`
    : `This payment exceeds the shared budget. ${money(remaining)} remains.`;
  else if (amount > capacity.l1 + capacity.l2) error = "The two Safes do not have enough available balance and allowance for this payment.";

  useEffect(() => {
    if (phase !== "pending" || !review) return;
    const timer = window.setTimeout(() => {
      setLedger({
        balances: { l1: ledger.balances.l1 - review.from.l1, l2: ledger.balances.l2 - review.from.l2 },
        spent: { l1: ledger.spent.l1 + review.from.l1, l2: ledger.spent.l2 + review.from.l2 },
        globalSpent: ledger.globalSpent + review.amount,
      });
      setHistory(previous => [review, ...previous]);
      setPhase("settled");
    }, 600);
    return () => window.clearTimeout(timer);
  }, [phase, review, ledger]);

  const edit = () => { setReview(null); setApprovals([]); setPhase("editing"); };
  const preset = (value: string, chain: Chain) => { edit(); setAmountInput(value); setDestination(chain); };
  const reset = () => { edit(); setLedger(initialLedger()); setHistory([]); setRecipient("Demo merchant"); setAmountInput("40"); setDestination("l2"); };
  const payment = review ?? { recipient, destination, amount, from };
  const routeVisible = review !== null || !error;

  return <section className={styles.treasury} aria-label="Treasury demo preview">
    <div className={styles.heading}>
      <div><p className="eez-eyebrow">[ ETHEREUM + EEZ-X ]</p><h2 ref={heading} tabIndex={-1}>One treasury, two Safes</h2>
        <p>One owner set. One shared budget. One payment funded from either chain.</p></div>
      <span className={styles.badge}>Interactive preview · Simulated data</span>
    </div>
    <p className={styles.notice}>This example uses sample balances and simulated approvals. It does not connect to treasury contracts, request wallet signatures or send transactions.</p>

    <div className={styles.overview}>
      <section className={styles.card} aria-label="Combined holdings"><h3>Combined holdings</h3>
        <strong className={styles.amount}>{money(ledger.balances.l1 + ledger.balances.l2)}</strong>
        <p>USDC held by the two Safes, including its EEZ-X representation.</p></section>
      <section className={styles.card} aria-label="Shared budget"><h3>Shared budget remaining</h3>
        <strong className={styles.amount}>{money(remaining)}</strong>
        <progress aria-label="Shared budget used" value={Number(ledger.globalSpent) / Number(unit)} max={150} />
        <p>{money(ledger.globalSpent)} spent of 150 USDC · per 10 minutes</p></section>
    </div>
    <div className={styles.overview}>{chains.map(chain => <section key={chain} className={styles.card} aria-label={`${names[chain]} Safe`}>
      <h3>{names[chain]} Safe</h3><dl className={styles.figures}>
        <div><dt>Balance</dt><dd>{money(ledger.balances[chain])}</dd></div>
        <div><dt>Allowance remaining</dt><dd>{money(chainLimit - ledger.spent[chain])}</dd></div>
        <div><dt>Spent this period</dt><dd>{money(ledger.spent[chain])} / 100 USDC</dd></div>
      </dl></section>)}</div>

    <div className={styles.workflow}>
      <section className={styles.card} aria-labelledby="treasury-payment-heading">
        <h3 id="treasury-payment-heading">Make one payment</h3>
        <div className={styles.presets} aria-label="Demo moments">
          <button className="btn btn-sm btn-outline" disabled={phase === "pending"} onClick={() => preset("40", "l2")}>Pay 40 on EEZ-X</button>
          <button className="btn btn-sm btn-outline" disabled={phase === "pending"} onClick={() => preset("110", "l1")}>Split 110 to Ethereum</button>
          <button className="btn btn-sm btn-outline" disabled={phase === "pending"} onClick={() => preset("1", "l2")}>Try another 1</button>
        </div>
        <fieldset className={styles.fields} disabled={phase !== "editing"}>
          <label htmlFor="treasury-recipient">Recipient</label>
          <input id="treasury-recipient" value={recipient} maxLength={120} onChange={event => setRecipient(event.target.value)} />
          <label htmlFor="treasury-amount">Amount (USDC)</label>
          <input id="treasury-amount" value={amountInput} inputMode="decimal" maxLength={20} autoComplete="off" onChange={event => setAmountInput(event.target.value)} />
          <label htmlFor="treasury-destination">Recipient’s chain</label>
          <select id="treasury-destination" value={destination} onChange={event => setDestination(event.target.value as Chain)}>
            <option value="l1">Ethereum</option><option value="l2">EEZ-X</option>
          </select>
        </fieldset>
        {phase === "editing" && error && <p className={styles.error} role="alert">{error}</p>}
        {routeVisible && <div className={styles.route} aria-label="Funding preview">
          <h4>{review ? "Reviewed funding" : "Proposed funding"}</h4>
          {chains.map(chain => payment.from[chain] > 0n && <p key={chain}><strong>{money(payment.from[chain])}</strong> from {names[chain]}{chain !== payment.destination ? " · bridged" : " · local"}</p>)}
          <p className={styles.receives}>{payment.recipient} receives <strong>{money(payment.amount)}</strong> on {names[payment.destination]}.</p>
          <details><summary>See token movements</summary>
            {chains.map(chain => payment.from[chain] > 0n && <p key={chain}>{money(payment.from[chain])}: {names[chain]} Safe → {chain === payment.destination
              ? `${payment.recipient} on ${names[payment.destination]}`
              : chain === "l2" ? `policy → bridge burn / L1 release → ${payment.recipient} on Ethereum`
              : `policy alias → bridge lock / L2 mint → ${payment.recipient} on EEZ-X`}.</p>)}
          </details>
        </div>}
        {phase === "editing" && <button className="btn btn-solid" disabled={!!error} onClick={() => {
          setReview({ recipient: recipient.trim(), destination, amount, from }); setApprovals([]); setPhase("approving");
        }}>Review payment</button>}
        {(phase === "approving" || phase === "settled") && <button className="btn btn-outline" onClick={edit}>{phase === "settled" ? "New payment" : "Edit payment"}</button>}
      </section>

      <section className={styles.card} aria-labelledby="treasury-owners-heading">
        <h3 id="treasury-owners-heading">One owner set</h3><p>Owners A, B and C · managed on Ethereum</p>
        <p>The same owners approve the EEZ-X Safe transaction. Two approvals are required.</p>
        <strong className={styles.quorum}>{approvals.length} of 2 simulated approvals</strong>
        <div className={styles.owners}>{["A", "B", "C"].map(owner => <button key={owner} className={`btn ${approvals.includes(owner) ? "btn-solid" : "btn-outline"}`}
          aria-pressed={approvals.includes(owner)} disabled={phase !== "approving" || approvals.includes(owner) || approvals.length >= 2}
          onClick={() => setApprovals(previous => [...previous, owner])}>Simulate {owner} approval</button>)}</div>
        <p>Editing a reviewed payment starts a fresh approval round.</p>
        {phase === "approving" && <button className="btn btn-solid" disabled={approvals.length < 2} onClick={() => setPhase("pending")}>Simulate settlement</button>}
        <div role="status" aria-live="polite">
          {phase === "editing" && "Review a payment to try the approval flow."}
          {phase === "approving" && (approvals.length < 2 ? "Waiting for simulated owner approvals." : "Ready to simulate this payment.")}
          {phase === "pending" && "Simulating settlement… Balances and budgets have not changed yet."}
          {phase === "settled" && "Simulation complete. The sample recipient received the payment and the sample budgets were updated."}
        </div>
      </section>
    </div>

    <section className={styles.card} aria-label="Simulated payment history"><h3>Simulated payment history</h3>
      {history.length === 0 ? <p>No simulated payments yet. Start with 40 USDC on EEZ-X.</p> : <ol className={styles.history}>{history.map((item, index) => <li key={history.length - index}>
        <div><strong>{money(item.amount)} → {item.recipient}</strong><p>{names[item.destination]} · {money(item.from.l1)} from Ethereum + {money(item.from.l2)} from EEZ-X</p></div>
        <span className={styles.badge}>Simulated</span></li>)}</ol>}
    </section>
    <div className={styles.reset}><p>Sample data resets when you leave or reload this example. The ten-minute period is illustrative; it does not advance automatically.</p>
      <button className="btn btn-sm btn-ghost" disabled={phase === "pending"} onClick={reset}>Reset simulation</button></div>
  </section>;
}
