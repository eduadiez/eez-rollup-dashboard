// Read-only preparation: bind the Safe service to this exact dashboard devnet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEventLog, getAddress, keccak256, parseAbi, pad, stringToHex } from 'viem';
import { TreasuryClient } from '../../src/lib/treasury/client.ts';
import { paymentState } from '../../src/lib/treasury/payments.ts';
const session = JSON.parse(readFileSync(process.argv[2]));
const c = session.treasury;
assert.equal(c.environment, 'isolated-devnet');
for (const chain of [c.l1, c.l2]) {
  const url = new URL(chain.rpc); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
}
assert.equal(c.l1.chainId, 1337); assert.equal(c.l2.chainId, 420691);
const client = new TreasuryClient(c);
await client.validate();
const snapshot = await client.snapshot(), state = await paymentState(client);
const logs = await client.rpc(c.l1.rpc, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest',
  topics: [keccak256(stringToHex('ProxyCreation(address,address)')), pad(c.safeL1)] }]);
assert.equal(logs.length, 1, 'one canonical Safe creation');
const log = logs[0], creation = decodeEventLog({ abi: parseAbi(['event ProxyCreation(address indexed proxy,address singleton)']), ...log });
const singleton = getAddress(creation.args.singleton);
const slot = await client.rpc(c.l1.rpc, 'eth_getStorageAt', [c.safeL1, '0x0', 'latest']);
assert.equal(getAddress(`0x${slot.slice(-40)}`), singleton);
await client.rpc(c.l1.rpc, 'trace_block', [log.blockNumber]);
const raw = { instance: c.instance, safe: c.safeL1, singleton, factory: getAddress(log.address),
  creationBlock: Number(BigInt(log.blockNumber)), creationTransaction: log.transactionHash,
  owners: snapshot.owners, threshold: snapshot.threshold, safeL2Nonce: String(snapshot.nonce),
  balances: { l1: String(state.balanceL1), l2: String(state.balanceL2), spent: String(state.spent) },
  token: c.payments.tokenL1, module: c.payments.moduleL1, alias: c.payments.alias,
  l1: c.l1, l2: c.l2, dashboard: session.url };
console.log(JSON.stringify(raw, null, 2));
