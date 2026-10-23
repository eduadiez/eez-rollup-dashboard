// Native Composer, proof signer and independent follower; fixture keys only.
import assert from 'node:assert/strict';
import { encodeFunctionData, decodeEventLog } from 'viem';
import { paymentState, tokenAbi } from '../../src/lib/treasury/payments.ts';

export async function runFaucetDeliveries(f, config, client, epoch) {
  const n = f.network, p = config.payments, artifact = f.artifact('out', 'TestUSDCFaucet');
  const faucet = await f.deploy(n.l1, artifact, [p.tokenL1, p.bridgeL1]);
  const before = await paymentState(client), cases = f.evidence.faucet = [];
  f.evidence.faucetFeeCoverage = "Pinned native fixture has no eez_quoteFee; native admission/replay only. Client quote binding uses fixture pricing in the separate Anvil suite.";
  for (const [destination, recipient, amount] of [
    ['l2', f.C.address, 1000_123456n], ['l1', p.recipient, 17_123456n], ['l2', f.C.address, 2_345678n],
  ]) {
    const token = destination === 'l1' ? p.tokenL1 : p.tokenL2;
    const previous = await f.read(n[destination].rpc, token, tokenAbi, 'balanceOf', [recipient]);
    const locked = await f.read(n.l1.rpc, p.tokenL1, tokenAbi, 'balanceOf', [p.bridgeL1]);
    const data = encodeFunctionData({ abi: artifact.abi, functionName: 'request', args: [recipient, amount, destination === 'l2'] });
    // This pinned fixture predates eez_quoteFee. Exercise real native admission,
    // signing and replay with its normal transaction helper, as the Safe tests
    // do. The production UI never falls back: its exact quote binding is covered
    // separately by the real-contract Anvil/client suite using fixture pricing.
    const receipt = await f.send(n.l1, faucet, data);
    assert.equal(receipt.status, '0x1');
    assert.equal((await f.rpc(n.l1.rpc, 'eth_getBlockByNumber', [receipt.blockNumber, false])).hash, receipt.blockHash);
    const event = receipt.logs.filter(log => log.address.toLowerCase() === faucet.toLowerCase())
      .map(log => decodeEventLog({ abi: artifact.abi, ...log })).find(event => event.eventName === 'TokensRequested');
    assert.equal(event.args.recipient.toLowerCase(), recipient.toLowerCase()); assert.equal(event.args.amount, amount);
    assert.equal(event.args.onL2, destination === 'l2');
    const settled = await f.until('canonical faucet token balance', async () => {
      const block = await f.rpc(n.l2.rpc, 'eth_getBlockByNumber', ['safe', false]);
      const current = await f.read(n[destination].rpc, token, tokenAbi, 'balanceOf', [recipient], destination === 'l2' ? block.number : receipt.blockNumber);
      return current === previous + amount ? block : false;
    });
    assert.equal(await f.read(n.l1.rpc, p.tokenL1, tokenAbi, 'balanceOf', [p.bridgeL1]), locked + (destination === 'l2' ? amount : 0n));
    await f.until('independent follower faucet replay', async () => (await f.rpc(n.follower, 'eth_getBlockByNumber', [settled.number, false]))?.hash === settled.hash);
    if (destination === 'l2') assert.equal(await f.read(n.follower, token, tokenAbi, 'balanceOf', [recipient], settled.number), previous + amount);
    const after = await paymentState(client);
    assert.equal(after.balanceL1, before.balanceL1); assert.equal(after.balanceL2, before.balanceL2);
    assert.equal(await f.read(n.l2.rpc, p.policy, f.artifact('out', 'TreasuryPolicy').abi, 'spent', [BigInt(epoch)]), before.spent);
    assert.equal(await f.read(n.l1.rpc, p.tokenL1, f.artifact('out', 'SharedTestUSDC').abi, 'allowance', [faucet, p.bridgeL1]), 0n);
    const wrappedSupply = await f.read(n.follower, p.tokenL2, f.artifact('out', 'WrappedToken').abi, 'totalSupply', [], settled.number);
    assert.equal(wrappedSupply, await f.read(n.l1.rpc, p.tokenL1, tokenAbi, 'balanceOf', [p.bridgeL1]));
    cases.push({ destination, recipient, amount: String(amount), hash: receipt.transactionHash, l1Block: receipt.blockNumber, l2Block: settled.number,
      previousBalance: String(previous), feeQuoted: false, nativeAdmission: true, independentReplay: true, backingVerified: true });
    f.evidence.lastSuccessfulL2Block = Number(BigInt(settled.number)); f.checkpoint();
    console.log(`Faucet ${destination}: exact ${amount}, canonical balances and independent replay verified`);
  }
}
