// Read-only: compare both Safe services with this exact devnet before linking it.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { TreasuryClient, safeAbi } from '../../src/lib/treasury/client.ts';
const sessionFile = resolve(process.argv[2]);
const session = JSON.parse(readFileSync(sessionFile));
const directory = resolve(dirname(sessionFile), 'safe-app');
const settings = JSON.parse(readFileSync(resolve(directory, 'settings.json')));
const deployment = JSON.parse(execFileSync(process.execPath, [new URL('./inspect.mjs', import.meta.url).pathname, sessionFile]));
assert.equal(deployment.instance, settings.deployment.instance, 'different devnet instance');
const client = new TreasuryClient(session.treasury);
const fetchJSON = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return response.json();
};
const uri = name => `http://127.0.0.1:${settings.ports[name]}`;
const [indexed, gateway, chain, nonce] = await Promise.all([
  fetchJSON(`${uri('txs')}/api/v1/safes/${deployment.safe}/`),
  fetchJSON(`${uri('cgw')}/v1/chains/1337/safes/${deployment.safe}`),
  fetchJSON(`${uri('cgw')}/v1/chains/1337`),
  client.read(session.treasury.l1.rpc, deployment.safe, safeAbi, 'nonce'),
]);
const owners = list => list.map(x => x.toLowerCase()).sort();
assert.deepEqual(owners(indexed.owners), owners(deployment.owners), 'indexer owners differ from L1');
assert.deepEqual(owners(gateway.owners.map(x => x.value)), owners(deployment.owners), 'gateway owners differ from L1');
for (const state of [indexed, gateway]) {
  assert.equal(state.threshold, deployment.threshold);
  assert.equal(BigInt(state.nonce), nonce);
  assert.equal(state.version, '1.4.1');
}
assert.equal(indexed.masterCopy.toLowerCase(), deployment.singleton.toLowerCase());
assert.equal(gateway.implementation.value.toLowerCase(), deployment.singleton.toLowerCase());
assert.equal(chain.chainId, '1337'); assert.equal(chain.shortName, 'trl1'); assert.equal(chain.isTestnet, true);
assert.equal(chain.rpcUri.value, session.treasury.l1.rpc);
assert.equal(chain.transactionService, uri('txs'));
const artifacts = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url)));
for (const contract of artifacts.deployments) {
  const code = await client.rpc(session.treasury.l1.rpc, 'eth_getCode', [contract.address, 'latest']);
  assert.equal(keccak256(code), contract.codeHash, `${contract.name}: code identity`);
}
const candidate = Object.entries(session.treasury.ownerLabels).find(([, name]) => name === 'Owner C')[0];
const decoded = await fetchJSON(`${uri('cgw')}/v1/chains/1337/data-decoder`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ to: deployment.safe, data: encodeFunctionData({
    abi: parseAbi(['function addOwnerWithThreshold(address owner,uint256 _threshold)']),
    functionName: 'addOwnerWithThreshold', args: [candidate, 2n],
  }) }),
});
assert.equal(decoded.method, 'addOwnerWithThreshold');
assert.equal(decoded.parameters[0].value.toLowerCase(), candidate.toLowerCase());
assert.equal(decoded.parameters[1].value, '2');
const safeAppUrl = `${uri('ui')}/settings/setup?safe=trl1:${deployment.safe}`;
const response = await fetch(safeAppUrl, { signal: AbortSignal.timeout(8000) });
assert(response.ok, `Safe app: HTTP ${response.status}`);
assert((await response.text()).includes('__NEXT_DATA__'), 'Safe app HTML missing');
const record = { checkedAt: new Date().toISOString(), instance: deployment.instance,
  dashboard: deployment.dashboard, safeAppUrl, owners: deployment.owners, threshold: deployment.threshold,
  l1SafeNonce: String(nonce), l2SafeNonce: deployment.safeL2Nonce, balances: deployment.balances,
  checks: ['deployment identity', 'indexed and gateway owners/threshold/nonce match L1', 'private chain RPC binding', 'Safe app HTML', 'canonical auxiliary contract code hashes', 'owner change decodes as C / threshold 2'],
  walletExtensionRehearsal: 'pending' };
writeFileSync(resolve(directory, 'readiness.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
