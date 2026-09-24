// Run against Vite + collector or the combined Compose deployment (Node 22+).
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
const origin = process.env.EEZ_TEST_UI_URL || 'http://127.0.0.1:8080';
for (const [path, contentType] of [
  ['/monitor/api/health', 'application/json'],
  ['/monitor/api/snapshot', 'application/json'],
]) {
  const response = await fetch(new URL(path, origin), {signal: AbortSignal.timeout(15000)});
  assert.equal(response.status, 200, path);
  assert.ok(response.headers.get('content-type')?.includes(contentType), path);
  if (path.endsWith('/health')) assert.equal((await response.json()).status, 'ok');
  else await response.arrayBuffer();
}
const live = new URL('/monitor/api/live', origin);
await new Promise((resolve, reject) => {
  const transport = live.protocol === 'https:' ? https : http;
  const request = transport.request(live, {headers: {
    Origin: live.origin,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
  }});
  const timeout = setTimeout(() => request.destroy(new Error('Monitor upgrade timed out')), 15000);
  request.on('error', error => { clearTimeout(timeout); reject(error); });
  request.on('response', response => {
    clearTimeout(timeout);
    response.resume();
    reject(new Error(`Monitor upgrade returned HTTP ${response.statusCode}`));
  });
  request.on('upgrade', (response, socket) => {
    clearTimeout(timeout);
    socket.destroy();
    try { assert.equal(response.statusCode, 101); resolve(); }
    catch (error) { reject(error); }
  });
  request.end();
});
console.log('Monitor proxy checks passed: health, snapshot, and same-origin WebSocket upgrade.');
