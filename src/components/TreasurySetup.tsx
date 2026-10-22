import { loadTreasuryArtifacts } from "../lib/treasury/release";
import { useEffect, useRef, useState } from "react";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import { TreasuryDeployment, loadDeployment, saveDeployment, sharedDeploymentKey, sharedManifestKey } from "../lib/treasury/deployment";
import type { DeploymentState, DeploymentTarget } from "../lib/treasury/deployment";
import type { TreasuryConfig } from "../lib/treasury/client";
import type { TreasuryWallet } from "./TreasuryConnected";
import styles from "./TreasuryDemo.module.css";

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function TreasurySetup({ wallet, target, onComplete }: { wallet: TreasuryWallet; target: DeploymentTarget; onComplete: (c: TreasuryConfig) => void }) {
  const [state, setState] = useState<DeploymentState | null>(null);
  const [deployer, setDeployer] = useState<TreasuryDeployment | null>(null);
  const [balances, setBalances] = useState<{ address: Address; l1: bigint; l2: bigint } | null>(null);
  const [existing, setExisting] = useState({ l1: true, l2: false });
  const [safeAddresses, setSafeAddresses] = useState({ l1: "", l2: "" });
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Checking the dashboard networks…");
  const [busy, setBusy] = useState(false);
  const [healthy, setHealthy] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const completed = useRef(onComplete); completed.current = onComplete;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const active = useRef(false), selectedWallet = useRef(wallet); selectedWallet.current = wallet;
  const persist = (next: DeploymentState) => { saveDeployment(localStorage, next); setState(next); };
  const locked = async (fn: (saved: DeploymentState | null) => Promise<void>, optional = false) => {
    if (!navigator.locks) throw new Error("Deployment requires a browser with Web Locks support.");
    await navigator.locks.request(sharedDeploymentKey, { ifAvailable: true }, async lock => {
      if (!lock) { if (optional) return; throw new Error("Another tab is updating this deployment"); }
      await fn(loadDeployment(localStorage));
    });
  };
  const steps = state && deployer ? deployer.steps(state) : [];
  const complete = !!state && !state.pending && state.completed.length === steps.length && steps.length > 0;
  const setupSalt = state?.salt;
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const saved = loadDeployment(localStorage);
        const next = new TreasuryDeployment(target, await loadTreasuryArtifacts(saved)); if (saved) next.steps(saved);
        await next.validate();
        if (alive) { setDeployer(next); setState(saved); setHealthy(true); setStatus(""); }
      } catch (e) { if (alive) setError(String(e)); }
    })();
    return () => { alive = false; };
  }, [target]);
  useEffect(() => {
    if (!deployer || complete) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const address = wallet.address as Address | undefined;
        if (address) {
          const [l1, l2] = await Promise.all((["l1", "l2"] as const).map(chain => deployer.rpc<Hex>(chain, "eth_getBalance", [address, "latest"])));
          if (alive) setBalances({ address, l1: BigInt(l1!), l2: BigInt(l2!) });
        } else if (alive) setBalances(null);
        if (!active.current) await locked(async saved => {
          if (!alive || active.current) return;
          if (!saved) { setState(null); return; }
          deployer.steps(saved);
          const tracked = await deployer.trackPending(saved);
          if (tracked !== saved && alive) persist(tracked);
          const reconciled = tracked.pending?.hash ? await deployer.reconcile(tracked) : tracked;
          if (reconciled !== saved && alive) setError("");
          if (reconciled !== saved && alive) persist(reconciled);
          const simplified = await deployer.simplify(reconciled);
          const grouped = await deployer.group(simplified);
          const prepared = await deployer.prepareWallet(await deployer.useExistingAsset(grouped));
          if (!alive) return;
          if (prepared !== reconciled) persist(prepared);
          const next = deployer.withoutFunding(prepared);
          if (next !== prepared) persist(next); else setState(prepared);
          if (next !== saved) setError("");
          if (next.pending?.hash) setStatus("Checking transaction…");
          else if (next.pending) setStatus("Waiting for the wallet transaction…");
          else setStatus(`${next.completed.length} transactions completed; ${deployer.steps(next).length - next.completed.length} remaining.`);
        }, true);
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) timer = setTimeout(poll, 4000); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [deployer, wallet.address, complete]);
  useEffect(() => {
    if (!complete || !deployer) return;
    let alive = true;
    setVerificationError("");
    void (async () => {
      if (!navigator.locks) throw new Error("Treasury verification requires a browser with Web Locks support.");
      // Wait for the final reconciliation to release the same lock used by
      // restart. Keep it through verification and publication of the manifest.
      await navigator.locks.request(sharedDeploymentKey, async () => {
        if (!alive) return;
        const saved = loadDeployment(localStorage);
        if (!saved || saved.salt !== setupSalt) throw new Error("Treasury setup changed. Reload to open the current treasury.");
        const deployment = await deployer.manifest(saved);
        if (!alive) return;
        localStorage.setItem(sharedManifestKey, JSON.stringify(deployment));
        completed.current(deployment);
      });
    })().catch(e => { if (alive) setVerificationError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [complete, deployer, setupSalt, verificationAttempt]);
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { active.current = false; setBusy(false); }
  };
  const awaitingAsset = !!state && state.version < 6 && !state.pending && !state.review && !state.addresses.bootstrapL1
    && (!state.addresses.tokenL1 || !!state.shared?.binding);
  const updatingPlan = state?.version === 6 && !state.pending && !state.review && !state.completed.includes("fundingBatchL1");
  const step = state && !awaitingAsset && !updatingPlan ? steps[state.completed.length] : undefined;
  const withoutFunding = !!state && state.version >= 7;
  const review = state?.review;
  const currentOwner = review?.owners.some(owner => same(owner, wallet.address));
  const signed = review?.approvals.some(approval => same(approval.owner, wallet.address));
  const readyToSend = !!step && !!state && !!wallet.provider && (step.safe ? !!review && review.approvals.length >= review.threshold && (!step.group || same(wallet.address, state.deployer)) : same(wallet.address, state.deployer));
  const planReady = !!state && state.version >= 3 || !!state?.review;
  const hasGas = !!step && !!balances && same(balances.address, wallet.address) && balances[step.chain] > 0n;
  const switchNetwork = async (chain: "l1" | "l2") => {
    const selected = selectedWallet.current;
    if (!selected.provider) throw new Error("Connect a wallet");
    if (!await (chain === "l1" ? selected.switchToL1() : selected.switchToL2())) throw new Error("Wallet network switch cancelled");
    return selected;
  };
  const actions = new Set([step?.id, ...(step?.group?.actions.map(item => item.id) ?? []), ...(step?.batch?.map(item => item.id) ?? [])]);
  const createsL1 = actions.has("safeL1"), createsL2 = actions.has("safeL2");
  const fundsL1 = actions.has("fundL1"), fundsL2 = actions.has("fundL2");
  const setsBudget = actions.has("policy"), setsAllowance = actions.has("limitL1") || actions.has("limitL2");
  const stepTitle = step && (({ contractsBatchL1: state?.reuse.l1 ? "Prepare your Chiado Safe" : "Create your Chiado Safe",
    contractsBatchL2: state?.reuse.l2 ? "Connect your EEZ-X Safe" : "Deploy your mirror Safe", fundingBatchL1: withoutFunding ? "Connect Safe owner verification" : state?.asset ? "Fund both Safes" : "Fund your EEZ-X Safe", approveFunding: "Approve treasury funding",
    budgetBatchL2: "Set the shared budget", configureL1: "Approve Chiado spending", configureL2: "Approve EEZ-X spending",
    singletonL1: "Deploy Safe 1.4.1 on Chiado", adoptL2: "Use one owner set" } as Record<string, string>)[step.id] ?? step.label);
  const stepDetails = step && ({
    contractsBatchL1: { title: "Prepare cross-chain payments", description: "These contracts identify your EEZ-X treasury on Chiado and enforce the Safe allowance you’ll approve later." },
    contractsBatchL2: { title: "Connect the mirror to your Chiado owners", description: state?.reuse.l2 && !state.reuse.l2.adapter
      ? "Prepare live owner verification. Your current EEZ-X owners will approve linking this Safe to the Chiado owners in a later step."
      : "Use EEZ’s cross-chain reads to verify transactions against your Chiado Safe’s current owners and approval threshold." },
    fundingBatchL1: { title: withoutFunding ? "Complete the owner-verification connection" : state?.asset ? "Transfer and bridge your funding" : "Connect and fund your mirror Safe", description: withoutFunding
      ? "Register the Chiado address used by your EEZ-X owner verifier so it can check the current owners of your Chiado Safe."
      : state?.asset ? "Transfer the approved Test USDC from your wallet into both Safes, using the shared bridge for the EEZ-X portion."
      : "Connect the cross-chain contracts and bridge Test USDC into your EEZ-X Safe." },
    budgetBatchL2: { title: "Create the shared budget and authorize EEZ-X spending", description: "Deploy the shared policy and give it a spending allowance on your EEZ-X Safe. Chiado spending is approved separately." },
    configureL1: { title: "Authorize treasury spending on Chiado", description: "Enable Safe’s allowance module and authorize your policy’s Chiado address to spend within this Safe’s limit." },
    configureL2: { title: "Authorize treasury spending on EEZ-X", description: "Enable Safe’s allowance module and authorize your treasury policy to spend within this Safe’s limit." },
  } as Record<string, { title: string; description: string }>)[step.id];
  const transactionActions = step && <ul>{step.group?.actions.map(action => <li key={action.id}>{action.label}</li>)}{step.batch?.map(call => <li key={call.id}>{call.label}</li>)}</ul>;
  const needsDeployer = !!step && (!step.safe || !!step.group);
  if (complete) return <section className={styles.treasury} aria-label="Treasury verification" aria-busy={!verificationError}>
    {verificationError ? <div className={styles.card}>
      <h3>Couldn’t verify your treasury</h3>
      <p className={styles.error} role="alert">{verificationError}</p>
      <button className="btn btn-solid" onClick={() => setVerificationAttempt(attempt => attempt + 1)}>Retry verification</button>
    </div> : <p className={styles.hint} role="status">Verifying your treasury…</p>}
  </section>;
  return <section className={styles.treasury} aria-label="Shared treasury setup">
    <div className={styles.heading}><div><p className="eez-eyebrow">[ CHIADO + EEZ-X ]</p><h2 ref={heading} tabIndex={-1}>Set up your shared treasury</h2>
      <p>Connect your existing Chiado Safe and deploy or connect its mirror on EEZ-X.</p></div><span className={styles.badge}>Shared testnet</span></div>
    {!state && <section className={styles.card}>
      <h3>Choose your Safes</h3>
      <p className={styles.safeExplanation}>EEZ’s synchronous cross-chain reads let your EEZ-X mirror Safe verify each transaction against the current owners of your Chiado Safe on L1. Manage owners on Chiado, and <strong>both Safes stay in sync automatically.</strong></p>
      <div className={styles.safeChoices}>{(["l1", "l2"] as const).map(chain => <div className={styles.fields} key={chain}>
        <label className={styles.chainLabel} data-chain={chain} htmlFor={`treasury-${chain}-${chain === "l1" ? "existing" : "choice"}`}>{chain === "l1" ? "Chiado Safe address" : "EEZ-X Safe"}</label>
        {chain === "l2" && <select id={`treasury-${chain}-choice`} value={existing[chain] ? "existing" : "new"} disabled={busy} onChange={event => setExisting(previous => ({ ...previous, [chain]: event.target.value === "existing" }))}>
          <option value="new">Deploy a mirror Safe</option><option value="existing">Use an existing Safe</option>
        </select>}
        {(chain === "l1" || existing[chain]) && <>{chain === "l2" && <label htmlFor={`treasury-${chain}-existing`}>Existing EEZ-X Safe address</label>}
          <input id={`treasury-${chain}-existing`} aria-describedby={`treasury-${chain}-hint`} value={safeAddresses[chain]} disabled={busy} placeholder="0x…" onChange={event => setSafeAddresses(previous => ({ ...previous, [chain]: event.target.value }))} />
          <p id={`treasury-${chain}-hint`} className={styles.hint}>{chain === "l1" ? "Keeps its current owners and approval threshold." : "Its current owners must approve using the Chiado Safe’s owners."}</p></>}
      </div>)}</div>
      {wallet.address ? <button className={`btn btn-solid btn-lg ${styles.startSetup}`} disabled={busy || !healthy || !safeAddresses.l1.trim()} onClick={() => void run(() => locked(async saved => {
        if (saved) throw new Error("Another tab has already selected a setup. Review the saved progress.");
        const selected = selectedWallet.current;
        if (!selected.address) throw new Error("Connect the deployment wallet");
        const next = deployer!.withoutFunding(await deployer!.prepareWallet(await deployer!.useExistingAsset(await deployer!.group(await deployer!.configure(getAddress(selected.address), getAddress(safeAddresses.l1), existing.l2 ? getAddress(safeAddresses.l2) : undefined)))));
        if (!same(selectedWallet.current.address, selected.address) || selectedWallet.current.provider !== selected.provider) throw new Error("Wallet changed during setup. Start setup again.");
        persist(next); setStatus("Setup reviewed. Approve each named transaction when ready.");
      }))}>Start setup</button> : <div className={styles.owners}>{wallet.walletOptions.map((option, index) => <button className={`btn ${index === 0 ? "btn-solid" : "btn-outline"}`} key={option.id} onClick={() => void wallet.connect(option.id)}>Connect {option.name}</button>)}
        {!wallet.walletOptions.length && <p>Open this dashboard in a browser with your wallet extension.</p>}</div>}
    </section>}
    {state && <section className={styles.card}>
      <div className={styles.setupProgress}><h3 className={styles.stepCount}>{awaitingAsset ? "Waiting for shared infrastructure" : updatingPlan ? "Updating setup…" : `Deployment ${state.completed.length} / ${steps.length}`}</h3>
        <progress aria-label="Setup progress" value={state.completed.length} max={steps.length || 1} /></div>
      {awaitingAsset && <p>Your confirmed setup is saved. The shared token and bridge pair must be predeployed before continuing.</p>}
      {step && <div className={styles.heading}>
        <h3>{stepTitle}</h3><span className={styles.chainLabel} data-chain={step.chain}>{step.chain === "l1" ? "Chiado" : "EEZ-X"}</span>
      </div>}
      {state.version < 3 && !state.pending && !state.review && <p>Checking the remaining setup…</p>}
      {step && <div className={styles.stepContext} aria-label="About this step">
        {createsL1 && <p>Your wallet <code>{state.deployer}</code> will be the only owner (1 of 1).</p>}
        {createsL2 && <p>This mirror Safe uses your Chiado Safe’s current owners and approval threshold.</p>}
        {state.reuse[step.chain] && <p>{step.chain === "l1" ? "Chiado" : "EEZ-X"} Safe: <code>{state.reuse[step.chain]!.address}</code></p>}
        {fundsL1 && !state.asset && <p>Add <strong>300 Test USDC</strong> to the Chiado Safe. Another 150 will fund the EEZ-X Safe in the funding step.</p>}
        {fundsL2 && !state.asset && <p>Bridge <strong>150 Test USDC</strong> into the EEZ-X Safe. The Chiado Safe keeps its 300 Test USDC.</p>}
        {(fundsL1 || fundsL2 || actions.has("tokenL1") || actions.has("claimTestUSDC")) && <p className={styles.hint}>{state.version >= 5 ? "This existing asset is Test USDC, not Circle-issued USDC." : "This is a test token created for your treasury, not Circle-issued USDC."} Your wallet pays network gas separately.</p>}
        {(setsBudget || setsAllowance) && <>
          <dl className={styles.limitSummary}>
            {setsBudget && <div><dt>Shared budget</dt><dd>150 Test USDC</dd></div>}
            {setsAllowance && <div><dt>{step.chain === "l1" ? "Chiado" : "EEZ-X"} Safe limit</dt><dd>100 Test USDC</dd></div>}
          </dl><p>Limits reset every ten minutes and apply to payments through this treasury policy.</p>
        </>}
        {step.migration && <p>The current EEZ-X owners will authorize replacing this Safe’s owner list with the Chiado Safe’s owners.</p>}
        {step.id.startsWith("prepareWalletL2_") && <p>Connect this wallet’s existing cross-chain address before creating the EEZ-X treasury.</p>}
        {step.id === "singletonL1" && <p>This transaction deploys Safe’s reusable contract code on Chiado. Your treasury Safe, with its own address and owners, will be created in a later step using this code.</p>}
      </div>}
      {step && needsDeployer && !same(wallet.address, state.deployer) && <p className={styles.notice}>Reconnect the recorded deployment wallet <code>{state.deployer}</code> to continue this transaction.</p>}
      {step && hasGas === false && balances && same(balances.address, wallet.address) && !state.pending && <p className={styles.hint}>Add test xDAI to your wallet on {step.chain === "l1" ? "Chiado" : "EEZ-X"} to continue.</p>}
      {step && (step.group || step.batch) && <section className={styles.stepDetails} aria-labelledby="treasury-step-actions">
        <h4 id="treasury-step-actions">{stepDetails?.title ?? step.label}</h4>
        {stepDetails && <p>{stepDetails.description}</p>}
        {transactionActions}
      </section>}
      {step?.safe && !state.pending && planReady && <div className={styles.approvalStep}>
        <p>Approve with {review ? `${review.threshold} current owner${review.threshold === 1 ? "" : "s"}` : "this Safe’s current owners"}, then submit the transaction.</p>
        <button className={`btn ${review ? "btn-ghost" : "btn-solid"}`} disabled={busy} onClick={() => void run(() => locked(async saved => {
          if (!saved || saved.pending) throw new Error("Deployment progress changed");
          persist({ ...saved, review: await deployer!.reviewStep(saved) });
        }))}>{review ? "Refresh Safe step review" : "Review Safe step"}</button>
        {review && <><p>{review.approvals.length} of {review.threshold} required owner approvals · Safe nonce {review.nonce}.</p>
          <details className={styles.disclosure}><summary>Current owners</summary>{review.owners.map(owner => <p key={owner}><code>{owner}</code></p>)}</details>
          <button className={`btn ${review.approvals.length >= review.threshold ? "btn-outline" : "btn-solid"}`} disabled={busy || !currentOwner || signed} onClick={() => void run(() => locked(async saved => {
            if (!saved || saved.pending) throw new Error("Deployment progress changed");
            const selected = await switchNetwork(review.chain);
            const approval = await deployer!.approve(saved, selected.provider!);
            if (!same(selectedWallet.current.address, approval.owner) || selectedWallet.current.provider !== selected.provider) throw new Error("Wallet changed while signing");
            persist({ ...saved, review: { ...saved.review!, approvals: [...saved.review!.approvals, approval] } });
          }))}>Approve Safe step</button>
          {!currentOwner && <p>Select one of these existing owners to approve. {step.group ? "Reconnect the deployment wallet to submit this contract batch after approvals." : "Any funded connected wallet can submit once the quorum is collected."}</p>}
        </>}
      </div>}
      {step && !state.pending && <button className={`btn ${step.safe && !readyToSend ? "btn-outline" : "btn-solid"}`} disabled={busy || !healthy || !planReady || !readyToSend || !hasGas}
        onClick={() => void run(() => locked(async saved => {
          if (!saved || saved.pending || saved.salt !== state.salt || saved.completed.length !== state.completed.length) throw new Error("Deployment progress changed. Wait for the current transaction.");
          const shared = await deployer!.useExistingAsset(saved);
          if (shared !== saved) { persist(shared); saved = shared; }
          const selected = await switchNetwork(step.chain);
          setStatus(`Preparing: ${step.label}`);
          const prepared = await deployer!.prepare(saved, selected.provider!);
          if (selectedWallet.current.provider !== selected.provider || !same(selectedWallet.current.address, prepared.pending.sender)) throw new Error("Wallet changed during preparation");
          if (prepared.expiresAt && BigInt(prepared.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error("Fee quote expired. Prepare this step again.");
          persist({ ...saved, pending: prepared.pending }); setStatus("Confirm the transaction in your wallet.");
          try {
            const hash = await selected.provider!.request({ method: "eth_sendTransaction", params: [prepared.request] });
            if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("No transaction hash returned");
            persist({ ...saved, pending: { ...prepared.pending, hash: hash as Hex } }); setStatus("");
          } catch (e) {
            if ((e as { code?: number }).code === 4001) { persist(saved); setStatus("Wallet cancelled. No transaction was authorized."); }
            else throw new Error(`Wallet response uncertain: ${String(e)}. We’ll keep checking the network automatically.`);
          }
        }))}>{busy ? "Waiting for wallet…" : step.safe ? "Submit approved Safe step" : "Approve next deployment step"}</button>}
      {!state.completed.length && !state.pending && <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => locked(async saved => {
        if (saved?.pending || saved?.completed.length) throw new Error("Setup has started; keep the recorded deployment wallet and Safes");
        localStorage.setItem(sharedDeploymentKey, ""); setState(null); heading.current?.focus();
      }))}>Change setup</button>}
    </section>}
    {status && (state || !healthy) && <p className={styles.hint} role="status">{status}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
