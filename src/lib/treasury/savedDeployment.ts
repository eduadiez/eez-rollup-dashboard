import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import type { Address } from "viem";
import type { Call, Chain, DeploymentState, TreasuryDeployment } from "./deployment.ts";
import { packSafeCalls } from "./safeSetup.ts";
import profile from "./shared-network.json" with { type: "json" };
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Frozen plans for already-saved setups. New selections never enter this path.
 * Reconstruct the original step order and exact signed calls from the journal's
 * pinned artifacts; do not migrate, reinterpret or resend pending work.
 */
export function savedDeploymentSteps(d: TreasuryDeployment, state: DeploymentState): Call[] {
  if (state.version >= 4) {
    const result = legacyGroupedSteps(d, state);
    check(state.completed.every((id, index) => result[index]?.id === id) && state.completed.length <= result.length, "Saved grouped deployment order does not match this build");
    return result;
  }
    const a = (name: string) => { const result = state.addresses[name]; check(result, `Missing completed deployment: ${name}`); return result; };
    const deploy = (id: string, label: string, chain: Chain, artifact: string, args: () => unknown[] = () => []): Call => ({ id, label, chain, artifact, args, output: id });
    const call = (id: string, label: string, chain: Chain, artifact: string, target: () => Address, method: string, args: () => unknown[], more: Partial<Call> = {}): Call => ({ id, label, chain, artifact, target, method, args, ...more });
    const initializer = (owner: Address) => encodeFunctionData({ abi: d.abi("Safe"), functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
    const registry = () => getAddress(profile.registry), manager = () => getAddress(profile.manager), rollup = BigInt(profile.rollupId);
    const plan: Call[] = [
      ...(!state.reuse.l1 ? [
      deploy("singletonL1", "Deploy Safe 1.4.1 on Chiado", "l1", "Safe"),
      deploy("factoryL1", "Deploy the Safe factory on Chiado", "l1", "SafeProxyFactory"),
      call("safeL1", "Create the 1-of-1 L1 Safe owned by your deployment wallet", "l1", "SafeProxyFactory", () => a("factoryL1"), "createProxyWithNonce", () => [a("singletonL1"), initializer(state.deployer), BigInt(state.salt)], { output: "safeL1", special: "safe" }),
      ] : []),
      ...(!state.reuse.l2 ? [
      deploy("singletonL2", "Deploy Safe 1.4.1 on EEZ-X", "l2", "Safe"),
      deploy("factoryL2", "Deploy the Safe factory on EEZ-X", "l2", "SafeProxyFactory"),
      ] : []),
      call("safeProxy", "Provision the L1 Safe's EEZ-X proxy", "l2", "Registry", manager, "getOrCreateCrossChainProxy", () => [a("safeL1"), 0n]),
      ...(!state.reuse.l2?.adapter ? [deploy("adapter", "Deploy live L1 owner verification", "l2", "L1Owners", () => [manager(), a("safeL1")])] : []),
      call("adapterAlias", "Provision owner verification's L1 alias", "l1", "Registry", registry, "getOrCreateCrossChainProxy", () => [a("adapter"), rollup]),
      ...(!state.reuse.l2 ? [call("safeL2", "Deploy the EEZ-X mirror Safe", "l2", "SafeProxyFactory", () => a("factoryL2"), "createProxyWithNonce", () => [a("singletonL2"), initializer(a("adapter")), BigInt(state.salt)], { output: "safeL2", special: "safe" })] : state.reuse.l2.adapter ? [] : [
        deploy("multiSendL2", "Deploy Safe's call-only batch helper", "l2", "MultiSendCallOnly"),
        call("adoptL2", "Use the L1 owners for this existing EEZ-X Safe", "l2", "MultiSendCallOnly", () => a("multiSendL2"), "multiSend", () => [], { safe: () => a("safeL2"), migration: true }),
      ]),
      deploy("action", "Deploy the owner-verification example", "l2", "TreasuryOwnerAction", () => [a("safeL2")]),
      deploy("tokenL1", "Deploy 450 Test USDC for this treasury", "l1", "DevnetUSDC"),
      deploy("aliasReaderL1", "Deploy the L1 alias lookup helper", "l1", "TreasuryAliasReader", () => [registry()]),
      deploy("invoiceMerchant", "Deploy the optional invoice merchant", "l1", "InvoiceMerchant", () => [a("tokenL1")]),
      deploy("bridgeL1", "Deploy and initialize the treasury's Chiado bridge", "l1", "ConfiguredTreasuryBridge", () => [a("tokenL1"), rollup, registry(), 0n, state.deployer]),
      deploy("bridgeL2", "Deploy and initialize the treasury's EEZ-X bridge", "l2", "ConfiguredTreasuryBridge", () => [a("tokenL1"), rollup, manager(), rollup, state.deployer]),
      call("pairL1", "Bind the Chiado bridge to its EEZ-X counterpart", "l1", "ConfiguredTreasuryBridge", () => a("bridgeL1"), "setCanonicalBridgeAddress", () => [a("bridgeL2")]),
      call("pairL2", "Bind the EEZ-X bridge to its Chiado counterpart", "l2", "ConfiguredTreasuryBridge", () => a("bridgeL2"), "setCanonicalBridgeAddress", () => [a("bridgeL1")]),
      call("fundL1", "Fund the L1 Safe with 300 Test USDC", "l1", "DevnetUSDC", () => a("tokenL1"), "transfer", () => [a("safeL1"), 300_000_000n]),
      call("approveBridge", "Approve exactly 150 Test USDC for bridging", "l1", "DevnetUSDC", () => a("tokenL1"), "approve", () => [a("bridgeL1"), 150_000_000n]),
      call("fundL2", "Bridge 150 Test USDC into the EEZ-X Safe", "l1", "ConfiguredTreasuryBridge", () => a("bridgeL1"), "bridgeTokens", () => [a("tokenL1"), 150_000_000n, rollup, a("safeL2")], { quoted: true, output: "tokenL2", special: "wrapped" }),
      deploy("moduleL1", "Deploy the official L1 spending-limit module", "l1", "AllowanceModule"),
      deploy("moduleL2", "Deploy the official EEZ-X spending-limit module", "l2", "AllowanceModule"),
      deploy("policy", "Deploy the shared 150 Test USDC budget", "l2", state.bidirectional ? "BidirectionalTreasuryPolicy" : "TreasuryPolicy", () => [a("safeL1"), a("safeL2"), manager(), a("aliasReaderL1"), a("moduleL1"), a("moduleL2"), a("tokenL1"), a("bridgeL2"), state.version === 3 && !state.addresses.invoiceMerchant ? zeroAddress : a("invoiceMerchant")]),
      call("alias", "Provision the policy's L1 spending delegate", "l1", "Registry", registry, "getOrCreateCrossChainProxy", () => [a("policy"), rollup], { output: "alias", special: "alias" }),
      call("merchantPolicy", "Bind the merchant to this policy", "l1", "InvoiceMerchant", () => a("invoiceMerchant"), "bindPolicy", () => [a("alias")]),
    ];
    for (const chain of ["l1", "l2"] as const) {
      const suffix = chain === "l1" ? "L1" : "L2", safe = () => a(`safe${suffix}`), module = () => a(`module${suffix}`);
      const delegate = () => a(chain === "l1" ? "alias" : "policy");
      const options = { safe, quoted: chain === "l2" };
      plan.push(call(`enable${suffix}`, `Enable the official ${suffix} allowance module`, chain, "Safe", safe, "enableModule", () => [module()], options),
        call(`delegate${suffix}`, `Set the ${suffix} policy spending delegate`, chain, "AllowanceModule", module, "addDelegate", () => [delegate()], options),
        call(`limit${suffix}`, `Set the ${suffix} ceiling to 100 per ten minutes`, chain, "AllowanceModule", module, "setAllowance", () => [delegate(), a(`token${suffix}`), 100_000_000n, 10, 10], options));
    }
    let result = plan;
    if (state.version === 3) {
      check(state.simplification && Number.isSafeInteger(state.simplification.preserved) && state.simplification.preserved >= 0
        && state.simplification.preserved <= state.completed.length && state.simplification.preserved <= plan.length, "Invalid simplified deployment prefix");
      const prefix = plan.slice(0, state.simplification.preserved), retained = new Set(prefix.map(step => step.id));
      const remaining = plan.slice(prefix.length);
      const invoice = retained.has("invoiceMerchant");
      result = [...prefix, ...remaining.filter(step => !state.simplification!.official[step.id]
        && step.id !== "action" && (invoice || !["invoiceMerchant", "merchantPolicy", "alias"].includes(step.id))
        && !/^(enable|delegate|limit)L[12]$/.test(step.id))];
      for (const chain of ["l1", "l2"] as const) {
        const suffix = chain === "l1" ? "L1" : "L2", helper = `multiSend${suffix}`;
        const batch = remaining.filter(step => step.id.endsWith(suffix) && /^(enable|delegate|limit)L[12]$/.test(step.id));
        if (chain === "l1" && !invoice && !retained.has("alias")) batch.unshift(plan.find(step => step.id === "alias")!);
        if (!batch.length) continue;
        // A late migration with one call left needs no extra helper deployment.
        // Keep a previously submitted/reviewed version-3 batch exactly resumable.
        const configuration = `configure${suffix}`;
        const batchStarted = state.completed.includes(helper) || state.completed.includes(configuration)
          || [helper, configuration].includes(state.pending?.id ?? "") || state.review?.id === configuration;
        if (batch.length === 1 && !batchStarted) { result.push(batch[0]!); continue; }
        if (!result.some(step => step.id === helper) && !state.simplification.official[helper])
          result.push(deploy(helper, `Deploy Safe's call-only batch helper on ${chain === "l1" ? "Chiado" : "EEZ-X"}`, chain, "MultiSendCallOnly"));
        result.push(call(`configure${suffix}`, `Configure ${chain === "l1" ? "Chiado" : "EEZ-X"} spending: 100 Test USDC per ten minutes`, chain,
          "MultiSendCallOnly", () => a(helper), "multiSend", () => [packSafeCalls(batch.map(step => ({ to: step.target!(),
            data: encodeFunctionData({ abi: d.abi(step.artifact), functionName: step.method!, args: step.args() }) })))],
          { safe: () => a(`safe${suffix}`), operation: 1, batch, quoted: chain === "l2" }));
      }
    }
    check(state.completed.every((id, index) => result[index]?.id === id) && state.completed.length <= result.length, "Saved deployment order does not match this build");
    return result;

}

/** Five phases keep cross-chain funding ahead of policy initialization. Every
 * decision about retained steps comes from the frozen pre-migration journal;
 * newly recorded addresses cannot silently remove a completed phase on reload.
 */
function legacyGroupedSteps(d: TreasuryDeployment, state: DeploymentState): Call[] {
  const source = state.grouping!.source;
  const old = d.steps(source), prefix = old.slice(0, source.completed.length);
  const has = (id: string) => !!source.addresses[id];
  const done = (id: string) => source.completed.includes(id);
  const a = (id: string): Address => { const value = state.addresses[id]; if (!value) throw new Error(`Missing completed deployment: ${id}`); return value; };
  const deploy = (id: string, label: string, chain: Chain, artifact: string, args: () => unknown[] = () => []): Call => ({ id, label, chain, artifact, args, output: id });
  const call = (id: string, label: string, chain: Chain, artifact: string, target: () => Address, method: string, args: () => unknown[], extra: Partial<Call> = {}): Call => ({ id, label, chain, artifact, target, method, args, ...extra });
  const registry = getAddress(profile.registry), manager = getAddress(profile.manager), rollup = BigInt(profile.rollupId);
  const init = (owner: Address) => encodeFunctionData({ abi: d.abi('Safe'), functionName: 'setup', args: [[owner], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
  const infrastructure = (chain: Chain) => {
    const suffix = chain === 'l1' ? 'L1' : 'L2';
    return [
      ...(!has(`singleton${suffix}`) && chain === 'l2' ? [deploy(`singleton${suffix}`, 'Deploy Safe 1.4.1', chain, 'Safe')] : []),
      ...(!has(`factory${suffix}`) && !state.reuse[chain] ? [deploy(`factory${suffix}`, 'Deploy Safe factory', chain, 'SafeProxyFactory')] : []),
    ];
  };
  const safe = (chain: Chain, owner: () => Address) => {
    const suffix = chain === 'l1' ? 'L1' : 'L2';
    return call(`safe${suffix}`, chain === 'l1' ? 'Create and initialize Safe' : 'Deploy and initialize the mirror Safe', chain, 'SafeProxyFactory', () => a(`factory${suffix}`), 'createProxyWithNonce', () => [a(`singleton${suffix}`), init(owner()), BigInt(state.salt)], { output: `safe${suffix}`, special: 'safe' });
  };
  const skipFunding = state.version >= 7;
  const existingAsset = state.version >= 6, shared = state.version >= 5, reused = !!state.shared?.binding || existingAsset;
  const bridgeArtifact = shared ? 'SharedTreasuryBridge' : 'BootstrapTreasuryBridge';
  const tokenArtifact = existingAsset ? 'ERC20' : shared ? 'SharedTestUSDC' : 'DevnetUSDC';
  const transfer = call('fundL1', 'Fund Chiado Safe with 300 Test USDC', 'l1', tokenArtifact, () => a('tokenL1'), 'transfer', () => [a('safeL1'), 300_000_000n]);
  const first: Call[] = [...infrastructure('l1'), ...(!has('safeL1') ? [safe('l1', () => state.deployer)] : []),
    ...(existingAsset ? [] : reused ? [call('claimTestUSDC', 'Receive 450 shared Test USDC', 'l1', tokenArtifact, () => a('tokenL1'), 'claim', () => [])]
      : [deploy('tokenL1', shared ? 'Create shared Test USDC' : 'Create 450 Test USDC', 'l1', tokenArtifact)]),
    deploy('aliasReaderL1', 'Deploy alias lookup', 'l1', 'TreasuryAliasReader', () => [registry]),
    ...(!reused ? [deploy('bridgeL1', shared ? 'Create the shared Chiado bridge' : 'Deploy Chiado bridge', 'l1', bridgeArtifact, () => [a('tokenL1'), rollup, registry, 0n, a('bootstrapL1')])] : []),
    deploy('moduleL1', 'Deploy official allowance module', 'l1', 'AllowanceModule'),
    ...(!has('multiSendL1') ? [deploy('multiSendL1', 'Deploy Safe call-only helper', 'l1', 'MultiSendCallOnly')] : []), ...(!existingAsset ? [transfer] : [])];
  const second: Call[] = [...infrastructure('l2'),
    ...(!done('safeProxy') && !state.grouping?.walletPreparation?.calls ? [call('safeProxy', 'Provision L1 Safe proxy', 'l2', 'Registry', () => manager, 'getOrCreateCrossChainProxy', () => [a('safeL1'), 0n])] : []),
    ...(!has('adapter') ? [deploy('adapter', 'Deploy live owner verification', 'l2', 'L1Owners', () => [manager, a('safeL1')])] : []),
    ...(!has('safeL2') ? [safe('l2', () => a('adapter'))] : []),
    ...(!reused ? [deploy('bridgeL2', shared ? 'Create the shared EEZ-X bridge' : 'Deploy EEZ-X bridge', 'l2', bridgeArtifact, () => [a('tokenL1'), rollup, manager, rollup, a('bootstrapL2')]),
    call('pairL2', 'Connect the EEZ-X bridge', 'l2', bridgeArtifact, () => a('bridgeL2'), 'setCanonicalBridgeAddress', () => [a('bridgeL1')]),
    call('releaseL2', shared ? 'Fix the shared EEZ-X bridge connection' : 'Return bridge administration to your wallet', 'l2', bridgeArtifact, () => a('bridgeL2'), shared ? 'seal' : 'transferAdmin', () => shared ? [] : [state.deployer])] : []),
    ...(!has('multiSendL2') ? [deploy('multiSendL2', 'Deploy Safe call-only helper', 'l2', 'MultiSendCallOnly')] : [])];
  const funding = [...(existingAsset && !skipFunding ? [call('pullFunding', 'Transfer 450 Test USDC from your wallet', 'l1', 'ERC20', () => a('tokenL1'), 'transferFrom', () => [state.deployer, a('bootstrapL1'), 450_000_000n]), transfer] : []), ...(!reused ? [call('pairL1', 'Connect the Chiado bridge', 'l1', bridgeArtifact, () => a('bridgeL1'), 'setCanonicalBridgeAddress', () => [a('bridgeL2')]),
    call('releaseL1', shared ? 'Fix the shared Chiado bridge connection' : 'Return bridge administration to your wallet', 'l1', bridgeArtifact, () => a('bridgeL1'), shared ? 'seal' : 'transferAdmin', () => shared ? [] : [state.deployer])] : []),
    ...(!done('adapterAlias') || skipFunding ? [call('adapterAlias', 'Provision owner verification alias', 'l1', 'Registry', () => registry, 'getOrCreateCrossChainProxy', () => [a('adapter'), rollup])] : []),
    ...(!skipFunding ? [call('approveBridge', 'Approve exactly 150 Test USDC', 'l1', tokenArtifact, () => a('tokenL1'), 'approve', () => [a('bridgeL1'), 150_000_000n]),
    call('fundL2', 'Bridge 150 Test USDC to EEZ-X Safe', 'l1', bridgeArtifact, () => a('bridgeL1'), 'bridgeTokens', () => [a('tokenL1'), 150_000_000n, rollup, a('safeL2')], { output: 'tokenL2', special: 'wrapped' })] : []),
    ...(shared && !reused ? [call('registerShared', 'Make this Test USDC and bridge pair reusable', 'l1', tokenArtifact, () => a('tokenL1'), 'registerBridges', () => [a('bridgeL1'), a('bridgeL2')])] : [])];
  const policy = [...(!has('moduleL2') ? [deploy('moduleL2', 'Deploy shared EEZ-X allowance module', 'l2', 'AllowanceModule')] : []),
    deploy('policy', 'Deploy the shared 150 Test USDC budget', 'l2', d.artifacts.build ? (d.artifacts.contracts.TreasuryPolicy?.verification ? 'TreasuryPolicy' : 'SplitTreasuryPolicy') : state.version >= 9 ? 'SplitTreasuryPolicy' : state.bidirectional ? 'BidirectionalTreasuryPolicy' : 'TreasuryPolicy', () => [a('safeL1'), a('safeL2'), manager, a('aliasReaderL1'), a('moduleL1'), a('moduleL2'), a('tokenL1'), a('bridgeL2')])];
  const config = (chain: Chain): Call => {
    const suffix = chain === 'l1' ? 'L1' : 'L2';
    const account = () => a(`safe${suffix}`), module = () => a(`module${suffix}`), delegate = () => a(chain === 'l1' ? 'alias' : 'policy');
    const batch = [
      ...(chain === 'l1' ? [call('alias', 'Provision policy spending delegate', chain, 'Registry', () => registry, 'getOrCreateCrossChainProxy', () => [a('policy'), rollup])] : []),
      call(`enable${suffix}`, 'Enable official module', chain, 'Safe', account, 'enableModule', () => [module()]),
      call(`delegate${suffix}`, 'Set policy delegate', chain, 'AllowanceModule', module, 'addDelegate', () => [delegate()]),
      call(`limit${suffix}`, 'Set 100 per ten minutes', chain, 'AllowanceModule', module, 'setAllowance', () => [delegate(), a(`token${suffix}`), 100_000_000n, 10, 10])];
    return call(`configure${suffix}`, `Configure ${chain === 'l1' ? 'Chiado' : 'EEZ-X'} spending`, chain, 'MultiSendCallOnly', () => a(`multiSend${suffix}`), 'multiSend', () => [packSafeCalls(batch.map(c => ({ to: c.target!(), data: encodeFunctionData({ abi: d.abi(c.artifact), functionName: c.method!, args: c.args() }) })))], { safe: account, operation: 1, batch, quoted: chain === 'l2' });
  };
  const group = (id: string, label: string, chain: Chain, create: boolean, actions: Call[], finish: boolean): Call => ({ id, label, chain, artifact: 'TreasuryBootstrap', args: () => [], group: { create, executor: chain === 'l1' ? 'bootstrapL1' : 'bootstrapL2', actions, finish } });
  const budget = { ...config('l2'), id: 'budgetBatchL2', label: 'Deploy the shared budget and configure EEZ-X spending', group: { create: false, executor: 'bootstrapL2', actions: policy, finish: true } };
  return [...prefix,
    ...(!has('singletonL1') && !state.reuse.l1 ? [deploy('singletonL1', 'Deploy Safe 1.4.1 on Chiado', 'l1', 'Safe')] : []),
    group('contractsBatchL1', existingAsset ? 'Create Chiado treasury contracts' : 'Create Chiado treasury contracts and fund its Safe', 'l1', true, first, false),
    ...Array.from({ length: state.grouping?.walletPreparation?.calls ?? 0 }, (_, index) => call(`prepareWalletL2_${index}`, index === 0 ? 'Connect the L1 Safe to EEZ-X' : 'Connect the Chiado bridge to EEZ-X', 'l2', 'Registry', () => manager, 'getOrCreateCrossChainProxy', () => [a(index === 0 ? 'safeL1' : 'bridgeL1'), 0n])),
    group('contractsBatchL2', state.reuse.l2 ? 'Connect the EEZ-X Safe and treasury contracts' : 'Deploy the EEZ-X mirror Safe and treasury contracts', 'l2', true, second, false),
    ...(state.reuse.l2 && !state.reuse.l2.adapter && !done('adoptL2') ? [call('adoptL2', 'Use the L1 owners for this existing EEZ-X Safe', 'l2', 'MultiSendCallOnly', () => a('multiSendL2'), 'multiSend', () => [], { safe: () => a('safeL2'), migration: true })] : []),
    ...(existingAsset && (!skipFunding || state.fundingSkipped?.source.completed.includes('approveFunding')) ? [call('approveFunding', 'Approve exactly 450 Test USDC for funding', 'l1', 'ERC20', () => a('tokenL1'), 'approve', () => [a('bootstrapL1'), 450_000_000n])] : []),
    { ...group('fundingBatchL1', skipFunding ? 'Connect Safe owner verification on Chiado' : existingAsset ? 'Fund both Safes from your wallet' : 'Connect the bridges and fund the EEZ-X Safe', 'l1', false, funding, true), quoted: !skipFunding }, budget, config('l1')];
}

