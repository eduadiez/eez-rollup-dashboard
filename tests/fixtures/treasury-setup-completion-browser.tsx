// UI lifecycle fixture. Contract verification is controlled here; deployment
// tests separately exercise the real receipt, code and allowance checks.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TreasurySetup } from "../../src/components/TreasurySetup";
import { TreasuryDeployment, loadDeployment, sharedDeploymentKey, sharedManifestKey } from "../../src/lib/treasury/deployment";
import { loadActiveManifest } from "../../src/lib/treasury/setupState";
import "../../src/styles/global.css";

export function mount(fixture: any) {
  const control = (window as any).completionTest = { checks: 0, walletCalls: 0, callbacks: 0, locks: [], confirm: false,
    failure: fixture.failure, release: undefined, unmount: undefined };
  TreasuryDeployment.prototype.validate = async function () {};
  TreasuryDeployment.prototype.rpc = async function () { return "0x1" as any; };
  TreasuryDeployment.prototype.steps = function () { return [{ id: "configureL1", label: "Approve Chiado spending", chain: "l1", artifact: "", args: () => [] }]; };
  for (const method of ["trackPending", "simplify", "group", "useExistingAsset", "prepareWallet", "withoutFunding"] as const)
    (TreasuryDeployment.prototype as any)[method] = (state: any) => state;
  TreasuryDeployment.prototype.reconcile = async function (state) {
    if (!control.confirm || !state.pending) return state;
    return { ...state, completed: [state.pending.id], transactions: [state.pending.hash!], pending: undefined };
  };
  TreasuryDeployment.prototype.manifest = async function (state) {
    control.checks++;
    control.locks.push((await navigator.locks.query()).held?.some(lock => lock.name === sharedDeploymentKey));
    if (fixture.deferred) await new Promise(resolve => { control.release = resolve; });
    if (control.failure) throw new Error(control.failure);
    if (state.pending || state.completed.length !== 1) throw new Error("Incomplete fixture");
    return fixture.manifest;
  };
  const wallet: any = { address: fixture.wallet, provider: { request() { control.walletCalls++; throw new Error("Unexpected wallet request"); } },
    walletOptions: [], switchToL1: async () => false, switchToL2: async () => false };
  function Harness() {
    const [, setRevision] = useState(0);
    const manifest = loadActiveManifest(localStorage);
    return <main style={{ maxWidth: 1000, margin: "30px auto", padding: 20 }}>{manifest
      ? <h2>Shared treasury</h2>
      : <TreasurySetup wallet={wallet} target={fixture.target} onComplete={() => {
        if (!loadDeployment(localStorage) || !localStorage.getItem(sharedManifestKey)) throw new Error("Missing verified treasury");
        control.callbacks++; setRevision(value => value + 1);
      }} />}</main>;
  }
  const root = createRoot(document.getElementById("root")!);
  control.unmount = () => root.unmount();
  root.render(<Harness />);
}
