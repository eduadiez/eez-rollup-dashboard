// Real token/bridge/module deployment on the owned process fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packSafeCalls } from '../../src/lib/treasury/safeSetup.ts';
import { encodeFunctionData, concatHex, zeroAddress, zeroHash, keccak256, encodeDeployData, encodeAbiParameters, parseAbiParameters, getContractAddress, getAddress } from 'viem';
import { buildSafeTransaction, packOwnerApprovals, encodeSafeExecution } from '../../src/lib/treasury/safeTransactions.ts';
export async function setupPayments(f, { legacy = false } = {}) {
  const { network: n, read, rpc, artifact, deploy, send, safeArtifact, A, B, adapter, safeL1, safeL2, manager } = f;
  const token = artifact('out', 'SharedTestUSDC'), bridge = artifact('out', 'SharedTreasuryBridge'), module = artifact('legacy/out', 'AllowanceModule'), policyArtifact = legacy ? (() => { const frozen = JSON.parse(readFileSync('contracts/legacy/artifacts/TreasuryPolicy.json')); return { abi: frozen.abi, bytecode: { object: frozen.bytecode } }; })() : artifact('out', 'InvoiceTreasuryPolicy');
  const tokenL1 = await deploy(n.l1, token);
  const bootstrapArtifact = artifact('out', 'TreasuryBootstrap');
  const helperArtifact = artifact('legacy/out', 'MultiSendCallOnly');
  const boolHash = keccak256(encodeAbiParameters(parseAbiParameters('bool'), [true]));
  const creation = (target, contract, args = []) => ({ create: true, target, data: encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode.object, args }), returnHash: zeroHash });
  const call = (target, contract, method, args = [], returnHash = zeroHash) => ({ create: false, target, data: encodeFunctionData({ abi: contract.abi, functionName: method, args }), returnHash });
  const predictedExecutor = async chain => getContractAddress({ from: f.submitter.address, nonce: BigInt(await rpc(chain.rpc, 'eth_getTransactionCount', [f.submitter.address, 'pending'])) });
  const bootstrapL1 = await predictedExecutor(n.l1);
  const aliasReaderL1 = getContractAddress({ from: bootstrapL1, nonce: 1n });
  const moduleL1 = getContractAddress({ from: bootstrapL1, nonce: 2n });
  assert.equal(getAddress(await deploy(n.l1, bootstrapArtifact, [f.submitter.address, [
    creation(aliasReaderL1, artifact('out', 'TreasuryAliasReader'), [n.registry]), creation(moduleL1, module),
  ]])), bootstrapL1);
  const bootstrapL2 = await predictedExecutor(n.l2);
  const helperL2 = getContractAddress({ from: bootstrapL2, nonce: 1n });
  assert.equal(getAddress(await deploy(n.l2, bootstrapArtifact, [f.submitter.address, [creation(helperL2, helperArtifact)]])), bootstrapL2);
  const moduleL2 = getContractAddress({ from: bootstrapL2, nonce: 2n });
  const policy = getContractAddress({ from: bootstrapL2, nonce: 3n });
  const merchantArtifact = artifact('out', 'InvoiceMerchant');
  const merchant = await deploy(n.l1, merchantArtifact, [tokenL1]);
  const bridgeL1 = await deploy(n.l1, bridge, [tokenL1, BigInt(n.rollupId), n.registry, 0n, f.submitter.address]);
  const bridgeL2 = await deploy(n.l2, bridge, [tokenL1, BigInt(n.rollupId), manager, BigInt(n.rollupId), f.submitter.address]);
  await send(n.l1, bridgeL1, encodeFunctionData({ abi: bridge.abi, functionName: 'setCanonicalBridgeAddress', args: [bridgeL2] }));
  await send(n.l2, bridgeL2, encodeFunctionData({ abi: bridge.abi, functionName: 'setCanonicalBridgeAddress', args: [bridgeL1] }));
  for (const [chain, address] of [[n.l1, bridgeL1], [n.l2, bridgeL2]])
    await send(chain, address, encodeFunctionData({ abi: bridge.abi, functionName: 'seal' }));
  const supplyBeforeFunding = await read(n.l1.rpc, tokenL1, token.abi, 'totalSupply');
  const walletBeforeFunding = await read(n.l1.rpc, tokenL1, token.abi, 'balanceOf', [f.submitter.address]);
  await send(n.l1, tokenL1, encodeFunctionData({ abi: token.abi, functionName: 'approve', args: [bootstrapL1, 450_000_000n] }));
  const fundingBatch = await send(n.l1, bootstrapL1, encodeFunctionData({ abi: bootstrapArtifact.abi, functionName: 'execute', args: [1n, [
    call(tokenL1, token, 'transferFrom', [f.submitter.address, bootstrapL1, 450_000_000n], boolHash),
    call(tokenL1, token, 'transfer', [safeL1, 300_000_000n], boolHash),
    call(tokenL1, token, 'approve', [bridgeL1, 150_000_000n], boolHash),
    call(bridgeL1, bridge, 'bridgeTokens', [tokenL1, 150_000_000n, BigInt(n.rollupId), safeL2]),
  ], true] }));
  (f.evidence.deploymentBatches ??= []).push({ chain: 'l1', executor: bootstrapL1, phase: 'funding', hash: fundingBatch.transactionHash, gasUsed: String(BigInt(fundingBatch.gasUsed)) });
  assert.equal(await read(n.l1.rpc, bootstrapL1, bootstrapArtifact.abi, 'closed'), true);
  assert.equal(await read(n.l1.rpc, tokenL1, token.abi, 'balanceOf', [bootstrapL1]), 0n);
  assert.equal(await read(n.l1.rpc, tokenL1, token.abi, 'totalSupply'), supplyBeforeFunding);
  assert.equal(await read(n.l1.rpc, tokenL1, token.abi, 'balanceOf', [f.submitter.address]), walletBeforeFunding - 450_000_000n);
  assert.equal(await read(n.l1.rpc, tokenL1, token.abi, 'allowance', [f.submitter.address, bootstrapL1]), 0n);
  f.evidence.walletFunding = { amount: '450000000', standardERC20: true, allowanceConsumed: true, supplyUnchanged: true };
  const tokenL2 = await f.until('backed wrapped USDC', async () => {
    const address = await read(n.l2.rpc, bridgeL2, bridge.abi, 'getWrappedToken', [tokenL1, 0n]);
    return address !== zeroAddress ? address : false;
  });

  await send(n.l1, tokenL1, encodeFunctionData({ abi: token.abi, functionName: 'registerBridges', args: [bridgeL1, bridgeL2] }));

  await send(n.l1, n.registry, encodeFunctionData({ abi: f.eeZAbi, functionName: 'getOrCreateCrossChainProxy', args: [policy, BigInt(n.rollupId)] }));
  const alias = await read(n.l1.rpc, n.registry, f.eeZAbi, 'computeCrossChainProxyAddress', [policy, BigInt(n.rollupId)]);
  await send(n.l1, merchant, encodeFunctionData({ abi: merchantArtifact.abi, functionName: 'bindPolicy', args: [alias] }));
  async function safeCall(onL1, to, data, operation = 0) {
    const safe = onL1 ? safeL1 : safeL2, chain = onL1 ? n.l1 : n.l2;
    const nonce = await read(chain.rpc, safe, safeArtifact.abi, 'nonce');
    const tx = buildSafeTransaction({ chainId: BigInt(chain.chainId), safe, to, data, nonce, operation });
    const owners = [A, B].sort((a, b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1);
    const approvals = await Promise.all(owners.map(async o => ({ owner: o.address, signature: await o.signTypedData(tx) })));
    const signatures = onL1 ? concatHex(approvals.map(a => a.signature)) : await packOwnerApprovals(tx, adapter, owners.map(o => o.address), 2, approvals);
    const execution = encodeSafeExecution(tx, signatures);
    const receipt = onL1 ? await send(chain, safe, execution) : await send(chain, bootstrapL2, encodeFunctionData({ abi: bootstrapArtifact.abi, functionName: 'execute', args: [1n, [
      creation(moduleL2, module),
      creation(policy, policyArtifact, [safeL1, safeL2, manager, aliasReaderL1, moduleL1, moduleL2, tokenL1, bridgeL2, merchant]),
      { create: false, target: safe, data: execution, returnHash: boolHash },
    ], true] }));
    if (!onL1) {
      (f.evidence.deploymentBatches ??= []).push({ chain: 'l2', executor: bootstrapL2, phase: 'deploy policy and configure Safe', hash: receipt.transactionHash, gasUsed: String(BigInt(receipt.gasUsed)) });
      assert.equal(await read(n.l2.rpc, bootstrapL2, bootstrapArtifact.abi, 'closed'), true);
      assert.equal(await read(n.l2.rpc, policy, policyArtifact.abi, 'safeL2'), getAddress(safeL2));
    }
    if (!onL1) await f.until('Safe configuration canonical', async () => {
      const head = await rpc(n.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
      return BigInt(head.number) >= BigInt(receipt.blockNumber);
    });
    return receipt;
  }
  for (const onL1 of [true, false]) {
    const safe = onL1 ? safeL1 : safeL2, m = onL1 ? moduleL1 : moduleL2, delegate = onL1 ? alias : policy;
    const helper = onL1 ? await deploy(n.l1, helperArtifact) : helperL2;
    const calls = [
      { to: safe, data: encodeFunctionData({ abi: safeArtifact.abi, functionName: 'enableModule', args: [m] }) },
      { to: m, data: encodeFunctionData({ abi: module.abi, functionName: 'addDelegate', args: [delegate] }) },
      // Base 10 minutes aligns resets to timestamp / 600, independent of setup time.
      { to: m, data: encodeFunctionData({ abi: module.abi, functionName: 'setAllowance', args: [delegate, onL1 ? tokenL1 : tokenL2, 100_000_000n, 10, 10] }) },
    ];
    const receipt = await safeCall(onL1, helper, encodeFunctionData({ abi: helperArtifact.abi, functionName: 'multiSend', args: [packSafeCalls(calls)] }), 1);
    (f.evidence.configurationBatches ??= []).push({ chain: onL1 ? 'l1' : 'l2', helper, hash: receipt.transactionHash, calls: 3 });
    const allowance = await read((onL1 ? n.l1 : n.l2).rpc, m, module.abi, 'getTokenAllowance', [safe, delegate, onL1 ? tokenL1 : tokenL2]);
    assert.deepEqual(allowance.slice(0, 3), [100_000_000n, 0n, 10n]);
    assert.equal(await read((onL1 ? n.l1 : n.l2).rpc, safe, safeArtifact.abi, 'isModuleEnabled', [delegate]), false);
  }
  const payments = { aliasReaderL1, policy, alias, tokenL1, tokenL2, moduleL1, moduleL2, bridgeL1, bridgeL2,
    ...(legacy ? {} : { l1Initiation: true, exactSplits: true }), combinedL2: true, percentageRules: true, invoiceMerchant: merchant, recipient: '0x0000000000000000000000000000000000001234', decimals: 6, period: 600, globalLimit: '150000000', assetLabel: 'Devnet USDC' };
  f.evidence.payments = payments;
  f.evidence.paymentInitialNonce = String(await read(n.l2.rpc, safeL2, safeArtifact.abi, 'nonce'));
  f.checkpoint();
  const bindings = [['l1', aliasReaderL1], ['l1', merchant], ['l1', tokenL1], ['l1', moduleL1], ['l1', bridgeL1], ['l1', alias], ['l2', tokenL2], ['l2', moduleL2], ['l2', bridgeL2], ['l2', policy]];
  const code = await Promise.all(bindings.map(async ([chain, address]) => ({ chain, address, hash: keccak256(await rpc(n[chain].rpc, 'eth_getCode', [address, 'latest'])) })));
  return { payments, code, safeCall, policyArtifact, token, module, bridge, merchantArtifact };
}
