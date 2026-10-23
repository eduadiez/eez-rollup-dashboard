import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress, keccak256, toHex, zeroAddress } from 'viem';
import { TreasuryDeployment, sharedDeploymentKey } from '../src/lib/treasury/deployment.ts';
import { TreasuryNetworkDeployment, readNetworkDeployment, networkDeploymentKey } from '../src/lib/treasury/networkDeployment.ts';
import { verifyAssetInfrastructure } from '../src/lib/treasury/assetInfrastructure.ts';
const artifacts = JSON.parse(readFileSync('src/lib/treasury/deployment-artifacts.json'));
const profile = JSON.parse(readFileSync('src/lib/treasury/shared-network.json'));
const address = n => getAddress(toHex(n, { size: 20 })), hash = s => keccak256(toHex(s));
const target = { l1: { rpc: 'http://localhost/l1', front: 'http://localhost/l1' }, l2: { rpc: 'http://localhost/l2', front: 'http://localhost/l2' }, fees: { l1: '1', l2: '1' } };
const asset = { tokenL1: address(100), tokenL2: address(101), bridgeL1: address(102), bridgeL2: address(103), tokenCodeHash: hash('token code') };
test('operator network provisioning has a separate journal and no treasury Safe funding', async () => {
  const d = new TreasuryNetworkDeployment(target, artifacts); d.validate = async () => {}; d.findSharedInfrastructure = async () => undefined;
  const state = await d.start(address(10));
  assert.notEqual(networkDeploymentKey, sharedDeploymentKey); assert.deepEqual(readNetworkDeployment(JSON.stringify(state)), state);
  const steps = d.steps(state), actions = steps.flatMap(s => s.group.actions);
  assert.equal(steps.length, 3); assert(!actions.some(s => s.artifact === 'Safe' || s.artifact === 'TreasuryPolicy'));
  assert(actions.find(s => s.id === 'seedWrapped').special === 'wrapped');
  assert(actions.findIndex(s => s.id === 'sealL1') < actions.findIndex(s => s.id === 'registerNetwork'));
  d.findSharedInfrastructure = async () => asset;
  await assert.rejects(d.start(address(11)), /already exists/);
});
test('existing-asset verification requires ERC20 metadata, frozen peers and a bound wrapped mint authority, without faucet calls', async () => {
  const d = new TreasuryDeployment(target, artifacts), tokenCode = '0x60006000', binding = { ...asset, tokenCodeHash: keccak256(tokenCode) }, block = { number: '0x20', hash: hash('block') };
  d.rpc = async (_chain, method, params) => method === 'eth_getBlockByNumber' ? block : params[0] === binding.tokenL1 ? tokenCode : params[0] === binding.tokenL2 ? artifacts.contracts.WrappedToken.runtime : artifacts.contracts.SharedTreasuryBridge.runtime;
  d.read = async (chain, _address, artifact, method) => {
    assert.notEqual(artifact, 'SharedTestUSDC');
    const values = { canonicalToken: binding.tokenL1, manager: chain === 'l1' ? profile.registry : profile.manager, rollupId: chain === 'l1' ? 0n : 1n, treasuryRollupId: 1n, admin: zeroAddress,
      canonicalBridgeAddress: chain === 'l1' ? binding.bridgeL2 : binding.bridgeL1, decimals: 6, getWrappedToken: binding.tokenL2, wrappedTokenInfo: [binding.tokenL1, 0n], BRIDGE: binding.bridgeL2 };
    assert(method in values, method); return values[method];
  };
  await verifyAssetInfrastructure(d, binding);
  await assert.rejects(verifyAssetInfrastructure(d, { ...binding, tokenCodeHash: hash('wrong') }), /asset code changed/);
  const original = d.read; d.read = (...args) => args[3] === 'decimals' ? 18 : original(...args);
  await assert.rejects(verifyAssetInfrastructure(d, binding), /six-decimal/);
});
