import { retainSourceRequests } from "../lib/treasury/sourceVerification";
import { loadTreasuryArtifacts } from "../lib/treasury/release";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, getAddress, toHex } from "viem";
import type { Hex } from "viem";
import { deploymentIdentity, readDeployment } from "../lib/treasury/deployment";
import type { DeploymentState, DeploymentTarget, FaucetRequest } from "../lib/treasury/deployment";
import { checkedFaucetRequest, parseFaucetAmount, TreasuryFaucetDeployment } from "../lib/treasury/networkDeployment";
import type { AssetInfrastructure } from "../lib/treasury/assetInfrastructure";
import profile from "../lib/treasury/shared-network.json";
import type { TreasuryWallet } from "./TreasuryConnected";
import { ExplorerLink } from "./ExplorerLink";
import styles from "./TreasuryDemo.module.css";

/** Explicit test-token requests, separate from every treasury journal. */
export function TreasuryFaucet({ wallet, target, onBack }: { wallet: TreasuryWallet; target: DeploymentTarget; onBack: () => void }) {
  const [d, setDeployment] = useState<TreasuryFaucetDeployment | null>(null);
  const [asset, setAsset] = useState<AssetInfrastructure | null>(null);
  const [state, setState] = useState<DeploymentState | null>(null);
  const [amount, setAmount] = useState("450"), [recipient, setRecipient] = useState("");
  const [destination, setDestination] = useState<"l1" | "l2">("l1");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const selected = useRef(wallet); selected.current = wallet;
  const active = useRef(false);
  const draftInitialized = useRef(false);
  const key = useMemo(() => asset && wallet.address ? `eez:treasury:faucet:${deploymentIdentity}:${asset.tokenL1.toLowerCase()}:${wallet.address.toLowerCase()}` : null, [asset, wallet.address]);
  const currentKey = useRef(key); currentKey.current = key;
  const load = () => {
    const saved = key ? readDeployment(localStorage.getItem(key)) : null;
    if (saved && (saved.version !== 2 || saved.deployer.toLowerCase() !== wallet.address?.toLowerCase()
      || saved.addresses.tokenL1?.toLowerCase() !== asset?.tokenL1.toLowerCase())) throw new Error("Invalid saved faucet request; preserve it for recovery");
    if (saved) d?.steps(saved);
    return saved;
  };
  const save = (next: DeploymentState) => {
    if (!key) throw new Error("Select a wallet");
    // A wallet response still belongs to its original journal after an account switch.
    retainSourceRequests(localStorage, next.sourceRequests);
    localStorage.setItem(key, JSON.stringify(next));
    if (currentKey.current === key) setState(next);
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        let next = new TreasuryFaucetDeployment(target, await loadTreasuryArtifacts());
        await next.validate(); const binding = await next.findAssetInfrastructure();
        if (!binding) throw new Error("Shared Test USDC has not been predeployed yet");
        const saved = wallet.address ? readDeployment(localStorage.getItem(`eez:treasury:faucet:${deploymentIdentity}:${binding.tokenL1.toLowerCase()}:${wallet.address.toLowerCase()}`)) : null;
        if (saved) next = new TreasuryFaucetDeployment(target, await loadTreasuryArtifacts(saved));
        if (alive) { setDeployment(next); setAsset(binding); }
      } catch (e) { if (alive) setError(String(e)); }
    })();
    return () => { alive = false; };
  }, [target, wallet.address]);
  useEffect(() => {
    setState(null); setLoadedKey(null);
    if (!key || !d || !asset || !wallet.address) return;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    try {
      const saved = load(), request = saved?.faucetRequests?.[saved.completed.length];
      setState(saved); setLoadedKey(key); setError("");
      // Changing the fee-paying wallet must not redirect an unsent claim.
      // A submitted request still restores the exact selection in its journal.
      if (request && (saved?.pending || !draftInitialized.current)) {
        setRecipient(request.recipient); setDestination(request.destination);
        setAmount(formatUnits(BigInt(request.amount), 6));
      } else if (!draftInitialized.current) setRecipient(wallet.address);
      draftInitialized.current = true;
    } catch (e) { setError(String(e)); return; }
    const poll = async () => {
      try {
        if (!active.current) await navigator.locks.request(key, { ifAvailable: true }, async lock => {
          if (!lock || !alive || active.current) return;
          const saved = load(); if (!saved) { setState(null); return; }
          const tracked = await d.trackPending(saved); if (alive && tracked !== saved) save(tracked);
          const next = tracked.pending?.hash ? await d.reconcile(tracked) : tracked;
          if (alive) { if (next !== saved) save(next); else setState(saved); }
        });
      } catch (e) { if (alive) setError(String(e)); }
      finally { if (alive) timer = setTimeout(poll, 4000); }
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [key, d]);
  const run = async (fn: () => Promise<void>) => {
    if (active.current || !key) return;
    active.current = true; setBusy(true); setError("");
    try { await navigator.locks.request(key, { ifAvailable: true }, async lock => { if (!lock) throw new Error("Another tab is updating this faucet request"); await fn(); }); }
    catch (e) { if (currentKey.current === key) setError(e instanceof Error ? e.message : String(e)); }
    finally { active.current = false; setBusy(false); }
  };
  let request: FaucetRequest | undefined, invalid = "";
  try { request = checkedFaucetRequest({ amount: String(parseFaucetAmount(amount.trim())), recipient: recipient.trim() as Hex, destination }); }
  catch (e) { invalid = e instanceof Error ? e.message : String(e); }
  const last = state?.completed[state.completed.length - 1]?.startsWith("faucetRequest_") ? state.faucetRequests?.[state.completed.length - 1] : undefined;
  const locked = busy || !!state?.pending || loadedKey !== key;
  const pendingChoice = state?.pending ? state.faucetRequests?.[state.completed.length] : undefined;
  return <section className={styles.treasury} aria-label="Test token faucet">
    <div className={styles.heading}><div><p className="eez-eyebrow">[ TEST ENVIRONMENT ]</p><h2>Get Test USDC</h2>
      <p>Send Test USDC to any wallet or Safe. Request more whenever you need it.</p></div><span className={styles.badge}>Testnet only</span></div>
    <section className={styles.card}>
      <fieldset className={styles.fields} disabled={locked}>
        <div className={styles.ownerFields}>
          <div className={styles.fields}><label htmlFor="faucet-amount">Amount (Test USDC)</label>
            <input id="faucet-amount" inputMode="decimal" autoComplete="off" value={pendingChoice ? formatUnits(BigInt(pendingChoice.amount), 6) : amount} onChange={e => setAmount(e.target.value)} /></div>
          <div className={styles.fields}><label htmlFor="faucet-network">Destination network</label>
            <select id="faucet-network" value={pendingChoice?.destination ?? destination} onChange={e => setDestination(e.target.value as "l1" | "l2")}><option value="l1">Chiado</option><option value="l2">EEZ-X</option></select></div>
        </div>
        <label htmlFor="faucet-recipient">Recipient address</label>
        <input id="faucet-recipient" placeholder="0x…" autoComplete="off" spellCheck={false} value={pendingChoice?.recipient ?? recipient} onChange={e => setRecipient(e.target.value)} />
        {wallet.address && recipient.toLowerCase() !== wallet.address.toLowerCase() && <button type="button" className="btn btn-outline" style={{ alignSelf: "start" }} onClick={() => setRecipient(wallet.address!)}>Use connected wallet</button>}
      </fieldset>
      {!state?.addresses.faucet && <p>Your first request needs two wallet confirmations: prepare the faucet, then send tokens.</p>}
      <p>{destination === "l2" ? "Confirm on Chiado; your tokens arrive on EEZ-X through the shared bridge." : "Confirm the request in your wallet on Chiado."}</p>
      <p className={styles.hint}>Your connected wallet pays gas on Chiado. To claim for another account, enter its recipient address. The recipient needs no xDAI to receive tokens.</p>
      {!wallet.address && <p>Connect your dashboard wallet to use the faucet.</p>}
      {invalid && wallet.address && !locked && <p role="status">{invalid}</p>}
      {state?.pending && <p role="status">Request pending.{state.pending.hash && <> <ExplorerLink value={state.pending.hash} type="tx" chain="l1" label="View transaction" /></>}</p>}
      {last && !state?.pending && <p role="status">{last ? `Last request: ${formatUnits(BigInt(last.amount), 6)} Test USDC delivered on ${last.destination === "l1" ? "Chiado" : "EEZ-X"}.` : "Previous faucet request confirmed."}</p>}
      {!state?.pending && <button className="btn btn-solid" disabled={locked || !d || !asset || !wallet.provider || !wallet.address || !request} onClick={() => void run(async () => {
        const current = selected.current, chosen = request!;
        const unchanged = () => { if (currentKey.current !== key || selected.current.address !== current.address || selected.current.provider !== current.provider) throw new Error("Wallet changed during preparation"); };
        if (!current.address || !current.provider) throw new Error("Select your wallet");
        if (BigInt(await current.provider.request({ method: "eth_chainId" }) as string) !== BigInt(profile.chains.l1.chainId)
          && !await current.switchToL1()) throw new Error("Wallet network change cancelled");
        unchanged();
        if (BigInt(await current.provider.request({ method: "eth_chainId" }) as string) !== BigInt(profile.chains.l1.chainId)) throw new Error("Wallet is still on another network");
        const accountUnchanged = async () => {
          const accounts = await current.provider!.request({ method: "eth_accounts" }) as string[];
          if (accounts[0]?.toLowerCase() !== current.address!.toLowerCase()) throw new Error("Wallet changed during preparation");
          unchanged();
        };
        await accountUnchanged();
        const saved = load(); if (saved?.pending) throw new Error("The faucet request changed; wait for tracking");
        const initial = saved ?? { build: d!.artifacts.build, version: 2, identity: deploymentIdentity, deployer: getAddress(current.address), salt: toHex(crypto.getRandomValues(new Uint8Array(32))), reuse: {}, addresses: { tokenL1: asset!.tokenL1 }, completed: [], transactions: [] } as DeploymentState;
        const next = d!.selectRequest(initial, asset!, chosen);
        const prepared = await d!.prepare(next, current.provider);
        await accountUnchanged();
        if (BigInt(await current.provider.request({ method: "eth_chainId" }) as string) !== BigInt(profile.chains.l1.chainId)) throw new Error("Wallet network changed during preparation");
        unchanged();
        if (prepared.expiresAt && BigInt(prepared.expiresAt) * 1000n <= BigInt(Date.now())) throw new Error("Fee quote expired. Request again to refresh it.");
        save({ ...next, pending: prepared.pending });
        try {
          const hash = await current.provider.request({ method: "eth_sendTransaction", params: [prepared.request] });
          if (typeof hash !== "string" || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Wallet response missing; automatic tracking will continue");
          save({ ...next, pending: { ...prepared.pending, hash: hash as Hex } });
        } catch (e) { if ((e as { code?: number }).code === 4001) save(next); throw e; }
      })}>{busy ? "Waiting for wallet…" : state?.addresses.faucet ? "Request Test USDC" : "Prepare faucet"}</button>}
      <p className={styles.hint}>Test tokens only; not Circle-issued USDC.</p>
    </section>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button className="btn btn-outline" onClick={onBack}>Back to treasury</button>
  </section>;
}
