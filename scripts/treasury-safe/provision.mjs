// Ordinary deployment transactions, only on the manifest-verified isolated L1.
// Public fixture A pays for auxiliary contracts; no Safe administration or token
// transfers are performed here. CREATE2 and runtime hashes must match Safe's release.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { concatHex, getContractAddress, keccak256, parseTransaction, toHex, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTreasuryConfig, TreasuryClient } from '../../src/lib/treasury/client.ts';
const sessionFile = resolve(process.argv[2]);
const c = parseTreasuryConfig(JSON.parse(readFileSync(sessionFile)).treasury);
assert.equal(c.l1.chainId, 1337); assert.equal(c.l2.chainId, 420691);
const client = new TreasuryClient(c); await client.validate();
const directory = resolve(dirname(sessionFile), 'safe-app');
const pins = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url)));
const factory = JSON.parse(readFileSync(resolve(directory, 'factory/package/artifacts/1337/deployment.json')));
const initcode = `0x${readFileSync(resolve(directory, 'factory/package/artifacts/bytecode.txt'), 'utf8').trim()}`;
const factoryTx = parseTransaction(factory.transaction);
assert.equal(factoryTx.chainId, 1337); assert.equal(factoryTx.data, initcode);
assert.equal(factoryTx.to, undefined); assert.equal(factoryTx.nonce, 0);
assert.equal(getContractAddress({from: factory.signerAddress, nonce: 0n}), factory.address);
// The pinned factory initializer returns its final 69 bytes (14-byte prefix).
assert.equal(initcode.slice(0, 30), '0x604580600e600039806000f350fe');
const factoryHash = keccak256(`0x${initcode.slice(30)}`);
const account = privateKeyToAccount(toHex(0xa11cen, { size: 32 }));
const recordFile = resolve(directory, 'auxiliary-deployments.json');
const record = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile)) : { instance: c.instance, transactions: [], contracts: [] };
assert.equal(record.instance, c.instance);
const persist = () => writeFileSync(recordFile, JSON.stringify(record, null, 2)+'\n');
const code = address => client.rpc(c.l1.rpc, 'eth_getCode', [address, 'latest']);
const receipt = async hash => {
  for (let i=0; i<240; i++) {
    const r = await client.rpc(c.l1.rpc, 'eth_getTransactionReceipt', [hash]);
    if (r) { assert.equal(r.status, '0x1', `deployment failed: ${hash}`); return r; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Deployment unresolved; inspect before retrying: ${hash}`);
};
const broadcast = async raw => {
  const hash = keccak256(raw);
  record.transactions.push({ hash }); persist();
  assert.equal(await client.rpc(c.l1.rpc, 'eth_sendRawTransaction', [raw]), hash);
  const r = await receipt(hash); Object.assign(record.transactions.at(-1), { block: r.blockNumber, success: true }); persist();
};
// Never blindly replay an earlier uncertain deployment attempt.
for (const tx of record.transactions.filter(tx => !tx.success)) {
  const r = await receipt(tx.hash); Object.assign(tx, { block: r.blockNumber, success: true }); persist();
}
const send = async (to, data, value=0n) => {
  const block = await client.rpc(c.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
  const raw = await account.signTransaction({ chainId: c.l1.chainId, to, data, value,
    nonce: Number(BigInt(await client.rpc(c.l1.rpc, 'eth_getTransactionCount', [account.address, 'pending']))),
    gas: 5_000_000n, type: 'eip1559', maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2n * BigInt(block.baseFeePerGas) + 1_000_000_000n });
  await broadcast(raw);
};
if (await code(factory.address) === '0x') {
  assert.equal(BigInt(await client.rpc(c.l1.rpc, 'eth_getTransactionCount', [factory.signerAddress, 'pending'])), 0n);
  const need = BigInt(factory.gasPrice) * BigInt(factory.gasLimit);
  const balance = BigInt(await client.rpc(c.l1.rpc, 'eth_getBalance', [factory.signerAddress, 'latest']));
  if (balance < need) await send(factory.signerAddress, '0x', need-balance);
  await broadcast(factory.transaction);
}
assert.equal(keccak256(await code(factory.address)), factoryHash, 'wrong singleton factory code');
for (const deployment of pins.deployments) {
  const artifact = JSON.parse(readFileSync(resolve(directory, 'contracts/package', deployment.artifact)));
  const predicted = getContractAddress({ from: factory.address, opcode: 'CREATE2', salt: zeroHash, bytecode: artifact.bytecode });
  assert.equal(predicted, deployment.address, `${deployment.name}: CREATE2 mismatch`);
  if (await code(predicted) === '0x') await send(factory.address, concatHex([zeroHash, artifact.bytecode]));
  assert.equal(keccak256(await code(predicted)), deployment.codeHash, `${deployment.name}: runtime mismatch`);
  if (!record.contracts.some(x => x.address === predicted)) record.contracts.push(deployment);
  persist(); console.log(`${deployment.name}: verified ${predicted}`);
}
