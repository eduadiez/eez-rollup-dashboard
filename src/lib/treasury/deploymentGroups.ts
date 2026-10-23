import { concatHex, encodeAbiParameters, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbiParameters, toHex, zeroAddress, zeroHash } from "viem";
import type { Address, Hex } from "viem";
import type { Call, Chain, DeploymentState, TreasuryDeployment } from "./deployment.ts";
import { packSafeCalls } from "./safeSetup.ts";
import profile from "./shared-network.json" with { type: "json" };

export type GroupAction = { create: boolean; target: Address; data: Hex; returnHash: Hex };
export type GroupOutput = { key: string; address: Address; artifact: string; index: number; initHash?: Hex; factory?: Address; singleton?: Address };
export type GroupReceipt = { executor: Address; create: boolean; sequence: string; finish: boolean; actionsHash: Hex; outputs: GroupOutput[] };
export const actionParameters = parseAbiParameters('(bool create,address target,bytes data,bytes32 returnHash)[]');
const boolHash = keccak256(encodeAbiParameters(parseAbiParameters('bool'), [true]));

/** New setups use verified existing assets and a selected L1 Safe. Initial
 * choices are frozen before the first wallet request so recording outputs never
 * changes the remaining plan. No token creation, claims or funding belong here.
 */
export function currentSteps(d: TreasuryDeployment, state: DeploymentState): Call[] {
  const has = (id: string) => !!state.plan!.addresses[id];
  const a = (id: string): Address => { const value = state.addresses[id]; if (!value) throw new Error(`Missing completed deployment: ${id}`); return value; };
  const deploy = (id: string, label: string, chain: Chain, artifact: string, args: () => unknown[] = () => []): Call => ({ id, label, chain, artifact, args, output: id });
  const call = (id: string, label: string, chain: Chain, artifact: string, target: () => Address, method: string, args: () => unknown[], extra: Partial<Call> = {}): Call => ({ id, label, chain, artifact, target, method, args, ...extra });
  const registry = getAddress(profile.registry), manager = getAddress(profile.manager), rollup = BigInt(profile.rollupId);
  const init = (owner: Address) => encodeFunctionData({ abi: d.abi('Safe'), functionName: 'setup', args: [[owner], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
  const mirror = () => call('safeL2', 'Deploy and initialize the mirror Safe', 'l2', 'SafeProxyFactory', () => a('factoryL2'), 'createProxyWithNonce', () => [a('singletonL2'), init(a('adapter')), BigInt(state.salt)], { output: 'safeL2', special: 'safe' });
  const first: Call[] = [
    ...(!has('aliasReaderL1') ? [deploy('aliasReaderL1', 'Deploy alias lookup', 'l1', 'TreasuryAliasReader', () => [registry])] : []),
    ...(!has('moduleL1') ? [deploy('moduleL1', 'Deploy official allowance module', 'l1', 'AllowanceModule')] : []),
    ...(!has('multiSendL1') ? [deploy('multiSendL1', 'Deploy Safe call-only helper', 'l1', 'MultiSendCallOnly')] : [])];
  const second: Call[] = [
    ...(!has('singletonL2') ? [deploy('singletonL2', 'Deploy Safe 1.4.1', 'l2', 'Safe')] : []),
    ...(!has('factoryL2') && !state.reuse.l2 ? [deploy('factoryL2', 'Deploy Safe factory', 'l2', 'SafeProxyFactory')] : []),
    ...(!state.plan?.walletPreparation?.calls ? [call('safeProxy', 'Provision L1 Safe proxy', 'l2', 'Registry', () => manager, 'getOrCreateCrossChainProxy', () => [a('safeL1'), 0n])] : []),
    ...(!has('adapter') ? [deploy('adapter', 'Deploy live owner verification', 'l2', 'L1Owners', () => [manager, a('safeL1')])] : []),
    ...(!has('safeL2') ? [mirror()] : []),
    ...(!has('multiSendL2') ? [deploy('multiSendL2', 'Deploy Safe call-only helper', 'l2', 'MultiSendCallOnly')] : [])];
  const ownerConnection = [call('adapterAlias', 'Provision owner verification alias', 'l1', 'Registry', () => registry, 'getOrCreateCrossChainProxy', () => [a('adapter'), rollup])];
  const policy = [...(!has('moduleL2') ? [deploy('moduleL2', 'Deploy shared EEZ-X allowance module', 'l2', 'AllowanceModule')] : []),
    deploy('policy', 'Deploy the shared 150 Test USDC budget', 'l2', 'TreasuryPolicy', () => [a('safeL1'), a('safeL2'), manager, a('aliasReaderL1'), a('moduleL1'), a('moduleL2'), a('tokenL1'), a('bridgeL2')])];
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
  return [
    group('contractsBatchL1', 'Prepare your Chiado Safe', 'l1', true, first, false),
    ...Array.from({ length: state.plan?.walletPreparation?.calls ?? 0 }, (_, index) => call(`prepareWalletL2_${index}`, index === 0 ? 'Connect the L1 Safe to EEZ-X' : 'Connect the Chiado bridge to EEZ-X', 'l2', 'Registry', () => manager, 'getOrCreateCrossChainProxy', () => [a(index === 0 ? 'safeL1' : 'bridgeL1'), 0n])),
    group('contractsBatchL2', state.reuse.l2 ? 'Connect the EEZ-X Safe and treasury contracts' : 'Deploy the EEZ-X mirror Safe and treasury contracts', 'l2', true, second, false),
    ...(state.reuse.l2 && !state.reuse.l2.adapter ? [call('adoptL2', 'Use the L1 owners for this existing EEZ-X Safe', 'l2', 'MultiSendCallOnly', () => a('multiSendL2'), 'multiSend', () => [], { safe: () => a('safeL2'), migration: true })] : []),
    group('fundingBatchL1', 'Connect Safe owner verification on Chiado', 'l1', false, ownerConnection, true), budget, config('l1')];

}

/** Resolve CREATE and official factory addresses before signing. Inputs are
 * bound in the pending transaction; only its canonical receipt records outputs.
 */
export async function materializeGroup(d: TreasuryDeployment, state: DeploymentState, id: string, nonce?: Hex) {
  const virtual: DeploymentState = { ...state, addresses: { ...state.addresses } };
  const step = d.steps(virtual).find(item => item.id === id)!;
  const group = step.group!;
  const executor = group.create ? getContractAddress({ from: state.deployer, nonce: BigInt(nonce!) }) : state.addresses[group.executor]!;
  virtual.addresses[group.executor] = executor;
  let nextNonce = group.create ? 1n : BigInt(await d.rpc<Hex>(step.chain, 'eth_getTransactionCount', [executor, 'latest']));
  let sequence = 0n;
  if (!group.create) {
    const [owner, closed, seq, code] = await Promise.all([
      d.read<Address>(step.chain, executor, 'TreasuryBootstrap', 'owner'), d.read<boolean>(step.chain, executor, 'TreasuryBootstrap', 'closed'),
      d.read<bigint>(step.chain, executor, 'TreasuryBootstrap', 'sequence'), d.rpc<Hex>(step.chain, 'eth_getCode', [executor, 'latest'])]);
    if (owner.toLowerCase() !== state.deployer.toLowerCase() || closed || !d.runtimeMatches(code, 'TreasuryBootstrap')) throw new Error('Deployment executor changed or already closed');
    sequence = seq;
  }
  const actions: GroupAction[] = [], outputs: GroupOutput[] = [];
  for (const call of group.actions) {
    const create = !call.method;
    const data = create ? encodeDeployData({ abi: d.abi(call.artifact), bytecode: d.artifacts.contracts[call.artifact]!.bytecode, args: call.args() })
      : encodeFunctionData({ abi: d.abi(call.artifact), functionName: call.method!, args: call.args() });
    const target = create ? getContractAddress({ from: executor, nonce: nextNonce++ }) : call.target!();
    if (create) {
      virtual.addresses[call.output!] = target;
      outputs.push({ key: call.output!, address: target, artifact: call.artifact, index: actions.length, initHash: keccak256(data) });
    } else if (call.special === 'safe') {
      const [singleton, initializer, salt] = call.args() as [Address, Hex, bigint];
      const proxyCode = outputs.some(output => output.artifact === 'SafeProxyFactory' && output.address === target)
        ? d.artifacts.contracts.SafeProxyFactory!.proxyCreationCode!
        : await d.read<Hex>(step.chain, target, 'SafeProxyFactory', 'proxyCreationCode');
      if (!proxyCode) throw new Error('Missing pinned factory proxy creation code');
      const bytecode = concatHex([proxyCode, encodeAbiParameters(parseAbiParameters('address'), [singleton])]);
      const address = getContractAddress({ opcode: 'CREATE2', from: target, salt: keccak256(concatHex([keccak256(initializer), toHex(salt, { size: 32 })])), bytecode });
      virtual.addresses[call.output!] = address;
      outputs.push({ key: call.output!, address, artifact: 'SafeProxy', index: actions.length, factory: target, singleton });
    }
    actions.push({ create, target, data, returnHash: ['DevnetUSDC', 'SharedTestUSDC', 'ERC20'].includes(call.artifact) && ['transfer', 'approve', 'transferFrom'].includes(call.method ?? '') ? boolHash : zeroHash });
  }
  return { step, executor, sequence, actions, outputs, addresses: virtual.addresses };
}

export function encodeGroup(d: TreasuryDeployment, state: DeploymentState, built: Awaited<ReturnType<typeof materializeGroup>>, safeExecution?: Hex) {
  const { step, executor, sequence, outputs } = built, group = step.group!;
  const actions = [...built.actions];
  if (safeExecution) actions.push({ create: false, target: step.safe!(), data: safeExecution, returnHash: boolHash });
  const actionsHash = keccak256(encodeAbiParameters(actionParameters, [actions]));
  const data = group.create ? encodeDeployData({ abi: d.abi('TreasuryBootstrap'), bytecode: d.artifacts.contracts.TreasuryBootstrap!.bytecode, args: d.abi('TreasuryBootstrap').find(item => item.type === 'constructor')?.inputs.length === 1 ? [actions] : [state.deployer, actions] })
    : encodeFunctionData({ abi: d.abi('TreasuryBootstrap'), functionName: 'execute', args: [sequence, actions, group.finish] });
  if (group.create && (data.length - 2) / 2 > 49152) throw new Error('Deployment batch exceeds the EVM creation size limit; preserve setup for review');
  const receipt: GroupReceipt = { executor, create: group.create, sequence: sequence.toString(), finish: group.finish, actionsHash, outputs };
  return { data, to: group.create ? undefined : executor, receipt };
}
