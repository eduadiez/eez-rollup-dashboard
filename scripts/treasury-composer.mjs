// Devnet-only compatibility adapter for the pinned Composer, which exposes
// eez_composerInfo but predates the wallet-compatible virtual eth_call probe.
// Discovery and transaction submission always use the same fixed upstream.
// This pinned fixture exposes queue status on the L2 node; bridge only that
// read-only method to its explicitly supplied loopback endpoint.
import { createServer } from 'node:http';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, stringToHex } from 'viem';
import { COMPOSER_DISCOVERY_ADDRESS, COMPOSER_DISCOVERY_ABI, COMPOSER_DISCOVERY_MARKER } from '../src/lib/composerDiscovery.ts';

export async function startComposerAdapter(upstream, expected) {
  const url = new URL(upstream);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
    throw new Error('The treasury Composer adapter requires a loopback upstream');
  if (expected.statusRpc) {
    const status = new URL(expected.statusRpc);
    if (status.protocol !== "http:" || status.hostname !== "127.0.0.1" || status.username || status.password)
      throw new Error("The treasury status adapter requires a loopback upstream");
  }
  const forward = async body => {
    const endpoint = ["eez_getCrossChainTransaction", "eez_getSettlementByL2Block"].includes(body.method) && expected.statusRpc ? expected.statusRpc : upstream;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Composer HTTP ${response.status}`);
    return response.json();
  };
  const rpc = async (method, params = []) => {
    const body = await forward({ jsonrpc: '2.0', id: 1, method, params });
    if (body.error || body.result === undefined) throw new Error(body.error?.message || 'Missing Composer response');
    return body.result;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('RPC request exceeds devnet size limit');
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const call = body?.params?.[0];
      let response;
      if (body?.method === 'eth_call' && call?.to?.toLowerCase() === COMPOSER_DISCOVERY_ADDRESS.toLowerCase()) {
        const { args: [nonce] } = decodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, data: call.data });
        if (encodeFunctionData({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo', args: [nonce] }).toLowerCase() !== call.data.toLowerCase())
          throw new Error('Invalid Composer discovery calldata');
        const [info, chain, genesis] = await Promise.all([
          rpc('eez_composerInfo'), rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]),
        ]);
        if (BigInt(chain) !== BigInt(expected.chainId) || genesis.hash.toLowerCase() !== expected.genesis.toLowerCase()
          || info.supportedNetworks?.eezL1 !== expected.l1ChainId || info.supportedNetworks?.eezL2 !== expected.l2ChainId
          || info.eezContracts?.eezRegistryAddress?.toLowerCase() !== expected.registry.toLowerCase()
          || info.eezContracts?.eezL2Address?.toLowerCase() !== expected.manager.toLowerCase())
          throw new Error('Composer upstream does not match this devnet');
        response = { jsonrpc: '2.0', id: body.id, result: encodeFunctionResult({ abi: COMPOSER_DISCOVERY_ABI, functionName: 'composerInfo',
          result: [COMPOSER_DISCOVERY_MARKER, 1n, nonce, BigInt(chain), stringToHex(JSON.stringify(info))] }) };
      } else response = await forward(body);
      res.end(JSON.stringify(response));
    } catch (error) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
