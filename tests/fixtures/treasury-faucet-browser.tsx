// UI lifecycle fixture only. No RPC connection or real wallet is used.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { encodeDeployData, encodeFunctionData, toHex } from "viem";
import { TreasuryFaucet } from "../../src/components/TreasuryFaucet";
import { TreasuryFaucetDeployment } from "../../src/lib/treasury/networkDeployment";
import { deploymentIdentity } from "../../src/lib/treasury/deployment";
import "../../src/styles/global.css";

export function mount(f: any) {
  const key = `eez:treasury:faucet:${deploymentIdentity}:${f.asset.tokenL1.toLowerCase()}:${f.owner.toLowerCase()}`;
  const control = (window as any).faucetTest = { key, receipt: f.receipt ?? true, writes: [] as any[], prepared: [] as any[], switches: 0,
    switchMode: "accept", sendMode: "accept", chainId: f.chainId ?? '0x27d8', address: f.owner, selectWallet: undefined as any, releaseSwitch: undefined as any };
  if (f.saved) localStorage.setItem(key, JSON.stringify(f.saved));
  TreasuryFaucetDeployment.prototype.validate = async () => {};
  TreasuryFaucetDeployment.prototype.findAssetInfrastructure = async () => f.asset;
  TreasuryFaucetDeployment.prototype.read = async () => { throw new Error("Faucet UI must not gate requests on token balances or prior claims"); };
  TreasuryFaucetDeployment.prototype.trackPending = async state => state;
  TreasuryFaucetDeployment.prototype.prepare = async function (state) {
    if (control.address === f.unfunded) throw new Error("The submitting wallet needs test xDAI on Chiado");
    const step = this.steps(state)[state.completed.length]!;
    const data = step.method ? encodeFunctionData({ abi: this.abi(step.artifact), functionName: step.method, args: step.args() })
      : encodeDeployData({ abi: this.abi(step.artifact), bytecode: this.artifacts.contracts[step.artifact]!.bytecode, args: step.args() });
    const pending = { id: step.id, chain: 'l1', sender: state.deployer, nonce: toHex(state.completed.length), data, ...(step.target ? { to: step.target() } : {}) } as any;
    control.prepared.push({ ...state, quoted: Boolean(step.quoted) });
    return { pending, request: { from: state.deployer, chainId: '0x27d8', nonce: pending.nonce, data, ...(pending.to ? { to: pending.to } : {}) },
      ...(step.quoted ? { expiresAt: toHex(Math.floor(Date.now() / 1000) + 30) } : {}) };
  };
  TreasuryFaucetDeployment.prototype.reconcile = async function (state) {
    if (!control.receipt || !state.pending?.hash) return state;
    const step = this.steps(state)[state.completed.length]!;
    const next: any = { ...state, pending: undefined, completed: [...state.completed, step.id], transactions: [...state.transactions, state.pending.hash] };
    if (step.output === 'faucet') {
      next.addresses = { ...next.addresses, faucet: f.faucet };
      next.faucetRequests = { ...next.faucetRequests, [next.completed.length]: { ...next.faucetRequests[state.completed.length], faucet: f.faucet } };
    }
    return next;
  };
  const provider: any = { request: async ({ method, params }: any) => {
    if (method === 'eth_chainId') return control.chainId;
    if (method === 'eth_accounts') return [control.address];
    if (method !== 'eth_sendTransaction') throw new Error(`Unexpected wallet method ${method}`);
    control.writes.push(params[0]);
    if (control.sendMode === 'reject') throw Object.assign(new Error('User rejected request'), { code: 4001 });
    if (control.sendMode === 'uncertain') throw new Error('Wallet connection interrupted');
    return f.hash;
  } };
  const target: any = { l1: { rpc: 'l1', front: 'l1' }, l2: { rpc: 'l2', front: 'l2' }, fees: { l1: '1', l2: '1' } };
  function Harness() {
    const [address, setAddress] = useState(f.owner), [chainId, setChainId] = useState(control.chainId);
    control.selectWallet = (account: string, chain: string) => { control.address = account; control.chainId = chain; setAddress(account); setChainId(chain); };
    const wallet: any = { address, chainId, provider, walletOptions: [], switchToL1: async () => {
      control.switches++;
      if (control.switchMode === 'reject') return false;
      if (control.switchMode === 'defer') await new Promise(resolve => { control.releaseSwitch = resolve; });
      if (control.switchMode !== 'noop') control.selectWallet(control.address, '0x27d8');
      return true;
    } };
    return <main style={{ maxWidth: 1100, margin: '32px auto', padding: 20 }}><TreasuryFaucet wallet={wallet} target={target} onBack={() => {}} /></main>;
  }
  createRoot(document.getElementById('root')!).render(<Harness />);
}
