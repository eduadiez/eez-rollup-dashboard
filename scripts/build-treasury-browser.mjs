// Package the exact local Foundry outputs for wallet-approved application deployment.
// Re-run after Solidity changes; the Docker frontend build consumes this generated file.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const contracts = {};
for (const [folder, names] of [['legacy/out', ['Safe', 'SafeL2', 'SafeProxyFactory', 'SafeProxy', 'AllowanceModule', 'MultiSendCallOnly']],
  ['out', ['L1Owners', 'TreasuryOwnerAction', 'DevnetUSDC', 'TreasuryAliasReader', 'InvoiceMerchant', 'ConfiguredTreasuryBridge', 'TreasuryPolicy', 'BidirectionalTreasuryPolicy', 'TreasuryPolicyUpgrade', 'SplitTreasuryPolicy', 'SplitTreasuryPolicyUpgrade', 'WrappedToken', 'TreasuryBootstrap', 'BootstrapTreasuryBridge', 'SharedTestUSDC', 'SharedTreasuryBridge', 'TestUSDCClaim', 'TestUSDCFaucet']]]) {
  for (const name of names) {
    const bytes = readFileSync(`contracts/${folder}/${name}.sol/${name}.json`);
    const a = JSON.parse(bytes);
    if (!/^0x[0-9a-f]+$/i.test(a.bytecode.object)) throw new Error(`Unlinked or missing bytecode: ${name}`);
    contracts[name] = { abi: a.abi, bytecode: a.bytecode.object, runtime: a.deployedBytecode.object,
      immutables: Object.values(a.deployedBytecode.immutableReferences ?? {}).flat(),
      immutableGroups: Object.values(a.deployedBytecode.immutableReferences ?? {}), artifactSha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
// Keep already reviewed/signed deployment journals byte-for-byte resumable.
// Both existing setup plans keep their reviewed creation bytecode. Policy
// upgrades use a separate artifact and never rewrite an outstanding request.
contracts.TreasuryPolicy = JSON.parse(readFileSync('contracts/legacy/artifacts/TreasuryPolicy.json', 'utf8'));
contracts.BidirectionalTreasuryPolicy = JSON.parse(readFileSync('contracts/legacy/artifacts/BidirectionalTreasuryPolicy.json', 'utf8'));
contracts.TreasuryPolicyUpgrade = JSON.parse(readFileSync('contracts/legacy/artifacts/TreasuryPolicyUpgrade.json', 'utf8'));
// Solidity 0.7.6 embeds different CBOR metadata for type(SafeProxy).creationCode
// inside the factory than in the standalone artifact. CREATE2 commits to those
// bytes too. Extract the unique embedded literal, accepting differences only
// in that exact compiler metadata span; integration compares the live getter.
const proxy = contracts.SafeProxy;
const creation = proxy.bytecode.slice(2), runtime = proxy.runtime.slice(2);
const runtimeAt = creation.indexOf(runtime);
const metadataLength = (Number.parseInt(runtime.slice(-4), 16) + 2) * 2;
const metadataStart = runtimeAt + runtime.length - metadataLength;
const factoryRuntime = contracts.SafeProxyFactory.runtime.slice(2);
const prefix = creation.slice(0, metadataStart);
const position = factoryRuntime.indexOf(prefix);
if (runtimeAt < 0 || metadataStart <= 0 || position < 0 || factoryRuntime.indexOf(prefix, position + 1) >= 0)
  throw new Error('Cannot uniquely identify pinned factory proxy creation code');
const embedded = factoryRuntime.slice(position, position + creation.length);
if (embedded.length !== creation.length || embedded.slice(metadataStart + metadataLength) !== creation.slice(metadataStart + metadataLength))
  throw new Error('Factory proxy executable differs from pinned standalone artifact');
contracts.SafeProxyFactory.proxyCreationCode = `0x${embedded}`;
const bundle = { version: 1,
  core: execFileSync('git', ['-C', 'contracts/lib/eez-core-protocol', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  safe: execFileSync('git', ['-C', 'contracts/lib/safe', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  modules: execFileSync('git', ['-C', 'contracts/lib/safe-modules', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), contracts };
const text = JSON.stringify(bundle) + '\n';
const destination = 'src/lib/treasury/deployment-artifacts.json';
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== text) throw new Error('Rebuild the treasury browser artifacts');
} else writeFileSync(destination, text);
console.log(`Treasury browser artifacts: ${Object.keys(contracts).length} contracts, ${text.length} bytes`);
