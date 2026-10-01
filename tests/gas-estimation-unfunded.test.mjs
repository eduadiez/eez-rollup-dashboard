// node tests/gas-estimation-unfunded.test.mjs   (Node >= 23: strips TypeScript types)
// Mocked JSON-RPC: priced eth_estimateGas from an unfunded sender fails with the
// node's balance cap, while an unpriced estimate returns the real requirement.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Source imports are extensionless ("../rpc"); resolve them to the .ts files.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const { estimateGas, GasEstimateError } = await import('../src/lib/gasEstimation.ts');

const REAL_GAS = 315_253n; // createCrossChainProxy on the chain-6293 registry
const calls = [];

function mockNode({ reverts = false } = {}) {
  globalThis.fetch = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ method, params });
    const reply = result => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    const fail = message => ({ json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }) });
    switch (method) {
      case 'eth_getBlockByNumber': return reply({ baseFeePerGas: '0x3b9aca00' });
      case 'eth_maxPriorityFeePerGas': return reply('0x3b9aca00');
      case 'eth_gasPrice': return reply('0x77359400');
      case 'eth_estimateGas': {
        if (reverts) return fail('execution reverted: SameNetworkProxy(1)');
        const tx = params[0];
        const priced = tx.gasPrice || tx.maxFeePerGas;
        return priced ? fail('gas required exceeds allowance (0)') : reply('0x' + REAL_GAS.toString(16));
      }
      case 'eth_call': return reverts ? fail('execution reverted: SameNetworkProxy(1)') : reply('0x');
      default: throw new Error(`unexpected RPC ${method}`);
    }
  };
}

const request = {
  rpcUrl: 'http://rpc.invalid',
  to: '0xdf3ff8e4f3f6d60c4dc4b45eb2007c6fd2d47482',
  data: '0xa7587c62' + '00'.repeat(12) + 'a33598830d322a9808f5c8803d2929a573bd1bea' + '00'.repeat(31) + '01',
  from: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
};

// Unfunded sender: must use the unpriced estimate, not the 200k eth_call fallback.
mockNode();
const result = await estimateGas(request);
assert.equal(result.method, 'unpriced');
assert.equal(result.rawEstimate, REAL_GAS);
assert.equal(result.gasLimit, (REAL_GAS * 130n) / 100n);
assert.ok(result.gasLimit > 260_000n, 'must exceed the old out-of-gas limit');
const estimates = calls.filter(c => c.method === 'eth_estimateGas').map(c => c.params[0]);
assert.equal(estimates.length, 3, 'EIP-1559, legacy, then unpriced');
assert.ok(!estimates[2].gasPrice && !estimates[2].maxFeePerGas);
assert.ok(!calls.some(c => c.method === 'eth_call'), 'no eth_call fallback needed');

// A genuine revert is still reported instead of guessing a gas limit.
calls.length = 0;
mockNode({ reverts: true });
await assert.rejects(estimateGas(request), e => e instanceof GasEstimateError && e.type === 'revert');

console.log('gas estimation with an unfunded sender: ok');
