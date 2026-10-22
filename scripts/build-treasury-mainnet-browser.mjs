// Separate bundle: never rewrite the frozen Chiado deployment bytes or journals.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const contracts = {};
for (const name of ['StandardBridgeTreasuryPolicy', 'StandardBridgeDelegate']) {
  const bytes = readFileSync(`contracts/out/${name}.sol/${name}.json`), a = JSON.parse(bytes);
  if (!/^0x[0-9a-f]+$/i.test(a.bytecode.object)) throw new Error(`Unlinked bytecode: ${name}`);
  contracts[name] = { abi: a.abi, bytecode: a.bytecode.object, runtime: a.deployedBytecode.object,
    immutables: Object.values(a.deployedBytecode.immutableReferences ?? {}).flat(),
    immutableGroups: Object.values(a.deployedBytecode.immutableReferences ?? {}), artifactSha256: createHash('sha256').update(bytes).digest('hex') };
}
const path = 'src/lib/treasury/mainnet-artifacts.json', text = JSON.stringify({ version: 1, contracts }) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) throw new Error('Rebuild the mainnet treasury artifacts');
} else writeFileSync(path, text);
console.log(`Mainnet treasury artifacts: ${Object.keys(contracts).length} contracts`);
