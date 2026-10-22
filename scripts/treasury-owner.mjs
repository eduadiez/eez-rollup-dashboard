// Normal owner-authorized L1 Safe administration using public fixture keys.
// This tool is scoped to the isolated manifest and never reads operator .env.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concatHex, encodeFunctionData, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTreasuryConfig, TreasuryClient } from '../src/lib/treasury/client.ts';
const [sessionFile, command] = process.argv.slice(2);
assert(sessionFile && ['add-c', 'remove-c'].includes(command), 'Usage: node scripts/treasury-owner.mjs <ui-session.json> add-c|remove-c');
const c = parseTreasuryConfig(JSON.parse(readFileSync(sessionFile)).treasury);
assert.equal(c.environment, "isolated-devnet", "Fixture owner tool requires an isolated devnet");
assert.equal(c.l1.chainId, 1337); assert.equal(c.l2.chainId, 420691);
const client = new TreasuryClient(c);
await client.validate();
const abi = JSON.parse(readFileSync(new URL('../contracts/legacy/out/Safe.sol/Safe.json', import.meta.url))).abi;
const [A, B, C] = [0xa11cen, 0xb0bn, 0xc0cn].map(key => privateKeyToAccount(toHex(key, { size: 32 })));
const owners = await client.read(c.l1.rpc, c.safeL1, abi, 'getOwners');
assert(owners.some(o => o.toLowerCase() === A.address.toLowerCase()) && owners.some(o => o.toLowerCase() === B.address.toLowerCase()), 'fixture owner set required');
const index = owners.findIndex(o => o.toLowerCase() === C.address.toLowerCase());
assert(command === 'add-c' ? index === -1 : index >= 0, 'owner C already in requested state');
const data = encodeFunctionData({ abi, functionName: command === 'add-c' ? 'addOwnerWithThreshold' : 'removeOwner',
  args: command === 'add-c' ? [C.address, 2n] : [index === 0 ? '0x0000000000000000000000000000000000000001' : owners[index - 1], C.address, 2n] });
const nonce = await client.read(c.l1.rpc, c.safeL1, abi, 'nonce');
const fields = [c.safeL1, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress];
const encoded = await client.rpc(c.l1.rpc, 'eth_call', [{ to: c.safeL1, data: encodeFunctionData({ abi, functionName: 'getTransactionHash', args: [...fields, nonce] }) }, 'latest']);
const signatures = await Promise.all([A, B].sort((a, b) => BigInt(a.address) < BigInt(b.address) ? -1 : 1).map(owner => owner.sign({ hash: encoded })));
const block = await client.rpc(c.l1.rpc, 'eth_getBlockByNumber', ['latest', false]);
const raw = await A.signTransaction({ chainId: c.l1.chainId, to: c.safeL1,
  data: encodeFunctionData({ abi, functionName: 'execTransaction', args: [...fields, concatHex(signatures)] }),
  nonce: Number(BigInt(await client.rpc(c.l1.rpc, 'eth_getTransactionCount', [A.address, 'pending']))),
  gas: 1_000_000n, type: 'eip1559', maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2n * BigInt(block.baseFeePerGas) + 1_000_000_000n });
const hash = await client.rpc(c.l1.rpc, 'eth_sendRawTransaction', [raw]);
const deadline = Date.now() + 120_000;
let receipt;
while (Date.now() < deadline) {
  receipt = await client.rpc(c.l1.rpc, 'eth_getTransactionReceipt', [hash]);
  if (receipt) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(receipt?.status, '0x1', `owner change failed or unresolved: ${hash}`);
console.log(JSON.stringify({ command, transaction: hash, blockNumber: receipt.blockNumber }));
