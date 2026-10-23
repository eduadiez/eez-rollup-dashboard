// Check real listener defaults in a private network namespace: never bind the
// developer's treasury-verification port or contact configured chain endpoints.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveConfig } from 'vite';

const compose = (...files) => JSON.parse(execFileSync('docker', [
  'compose', '--env-file', '/dev/null', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json',
], { encoding: 'utf8' }));
const standard = compose('docker-compose.yml').services;
const host = compose('docker-compose.yml', 'docker-compose.host-rpc.yml').services;
delete process.env.EEZ_TRACE_UPSTREAM;
const { server: { proxy } } = await resolveConfig({ envFile: false }, 'serve');
const verificationPort = Number(new URL(proxy['/treasury-verification'].target).port);
const tracePort = Number(new URL(proxy['/trace/api'].target).port);
assert.equal(host.verification.network_mode, 'service:ui');
assert.equal(host.ui.network_mode, 'host');
assert.equal(host['trace-decoder'].network_mode, 'host');
assert.equal(host.ui.environment.EEZ_UI_TRACE_UPSTREAM, `127.0.0.1:${tracePort}`);
assert.equal(Number(host['trace-decoder'].environment.EEZ_TRACE_PORT), tracePort);
assert.notEqual(tracePort, verificationPort, 'decoder must not take the treasury-verification port');
assert.equal(proxy['/dashboard/trace/api'].target, proxy['/trace/api'].target);
assert.equal(proxy['/trace/api'].rewrite('/trace/api/jobs'), '/api/jobs');
assert.equal(proxy['/dashboard/trace/api'].rewrite('/dashboard/trace/api/jobs'), '/api/jobs');
const containerPort = Number(standard['trace-decoder'].environment.EEZ_TRACE_PORT);
assert.equal(standard.ui.environment.EEZ_UI_TRACE_UPSTREAM, `trace-decoder:${containerPort}`);

const modes = [
  { name: 'local default', env: {}, port: tracePort },
  { name: 'host-network overlay', env: {
    EEZ_TRACE_HOST: host['trace-decoder'].environment.EEZ_TRACE_HOST,
    EEZ_TRACE_PORT: host['trace-decoder'].environment.EEZ_TRACE_PORT,
  }, port: tracePort },
  { name: 'standard container', env: {
    EEZ_TRACE_HOST: standard['trace-decoder'].environment.EEZ_TRACE_HOST,
    EEZ_TRACE_PORT: standard['trace-decoder'].environment.EEZ_TRACE_PORT,
  }, port: containerPort },
];
const probe = `
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startServer } from '/app/trace-decoder/service/server.mjs';
import { workerRunner } from '/app/trace-decoder/service/runner.mjs';
const verification = http.createServer((_req, res) => res.end('verification'));
verification.listen(${verificationPort}, '127.0.0.1');
await once(verification, 'listening');
try {
  for (const mode of ${JSON.stringify(modes)}) {
    const server = startServer({ EEZ_UI_L1_RPC_UPSTREAM: 'http://127.0.0.1:9',
      EEZ_UI_L2_RPC_UPSTREAM: 'http://127.0.0.1:9', ...mode.env });
    try {
      await once(server, 'listening');
      assert.equal(server.address().port, mode.port);
      const health = await fetch('http://127.0.0.1:' + mode.port + '/api/health', { headers: { connection: 'close' } });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ready: true });
      assert.equal(await (await fetch('http://127.0.0.1:${verificationPort}/', { headers: { connection: 'close' } })).text(), 'verification');
      console.log(mode.name + ': decoder and verification listeners coexist');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  // Load the shipped worker and engine, then reject before any RPC request.
  const run = workerRunner({ expectedL1ChainId: '1' }, { timeoutMs: 5000 });
  await assert.rejects(run({ chainIds: { l1: '2', l2: '200' } }, () => {}).promise,
    { code: 'network-mismatch' });
  console.log('Production worker loads and rejects a mismatched network before RPC');
} finally { verification.closeAllConnections(); await new Promise(resolve => verification.close(resolve)); }
`;
const name = `eez-trace-check-${randomUUID()}`;
mkdirSync('.runtime', { recursive: true });
const directory = mkdtempSync(resolve('.runtime/trace-service-check-'));
writeFileSync(`${directory}/probe.mjs`, probe);
try {
  process.stdout.write(execFileSync('docker', ['run', '--rm', '--name', name,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,src=${directory}/probe.mjs,dst=/tmp/trace-services.mjs,readonly`,
    '--entrypoint', 'node', process.argv[2] || 'eez-trace-decoder:check', '/tmp/trace-services.mjs'],
  { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
} finally {
  try { execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' }); } catch { /* --rm already removed it. */ }
  rmSync(directory, { recursive: true, force: true });
}
