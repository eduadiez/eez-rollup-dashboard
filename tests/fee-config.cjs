// Exercise Compose interpolation and the shipping runtime-config entrypoint.
// Containers have no network, ports, operator volumes, or chain credentials.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const image = process.env.EEZ_UI_TEST_IMAGE;
assert(image, 'Build the dashboard image and set EEZ_UI_TEST_IMAGE');
const root = path.resolve(__dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'eez-ui-fee-config-'));
const envFile = path.join(temporary, 'fixture.env');
const keys = ['L1', 'L2'].flatMap(chain => [
  `EEZ_UI_${chain}_FEES_ENABLED`, `EEZ_UI_${chain}_FEE_MAX_TOTAL_WEI`,
]);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('EEZ_') && !key.startsWith('COMPOSE_')));
const defaults = {
  l1FeesEnabled: false, l2FeesEnabled: false,
  l1FeeMaxTotalWei: '100000000000000000', l2FeeMaxTotalWei: '100000000000000000',
};
let scenarios = 0;

function run(args, env = inherited) {
  const result = spawnSync('docker', args, {
    cwd: root, env, encoding: 'utf8', timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

function check(fileValues = {}, shellValues = {}, expected = defaults, errorKey) {
  writeFileSync(envFile, Object.entries(fileValues).map(([key, value]) => `${key}=${value}\n`).join(''));
  const compose = run(['compose', '--env-file', envFile, '-f', 'docker-compose.yml', 'config', '--format', 'json'],
    { ...inherited, ...shellValues });
  assert.equal(compose.status, 0, compose.stderr);
  const environment = JSON.parse(compose.stdout).services.ui.environment;
  const variables = keys.flatMap(key => ['--env', `${key}=${environment[key]}`]);
  const rendered = run(['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
    ...variables, image, '-c', '/docker-entrypoint.d/30-eez-runtime-config.sh && cat /usr/share/nginx/html/config.json']);
  if (errorKey) {
    assert.notEqual(rendered.status, 0, `${errorKey} should prevent startup`);
    assert(rendered.stderr.includes(`${errorKey} must be`), rendered.stderr);
    // Invalid local-development settings must fail before contacting Kurtosis
    // or replacing an existing .runtime/config.json.
    const dev = spawnSync('bash', ['scripts/configure-kurtosis.sh'], {
      cwd: root, env: { ...inherited, ...fileValues, ...shellValues }, encoding: 'utf8', timeout: 5000,
    });
    if (dev.error) throw dev.error;
    assert.notEqual(dev.status, 0);
    assert(dev.stderr.includes(`${errorKey} must be`), dev.stderr);
  } else {
    assert.equal(rendered.status, 0, rendered.stderr);
    const config = JSON.parse(rendered.stdout);
    for (const [key, value] of Object.entries(expected)) assert.equal(config[key], value, key);
  }
  scenarios++;
}

try {
  check();
  check(Object.fromEntries(keys.map(key => [key, ''])));
  for (const chain of ['L1', 'L2']) {
    const flag = `EEZ_UI_${chain}_FEES_ENABLED`;
    const cap = `EEZ_UI_${chain}_FEE_MAX_TOTAL_WEI`;
    const prefix = chain.toLowerCase();
    check({ [flag]: 'true', [cap]: '12345' }, {},
      { ...defaults, [`${prefix}FeesEnabled`]: true, [`${prefix}FeeMaxTotalWei`]: '12345' });
    check({ [flag]: 'false', [cap]: '1' }, { [flag]: 'true', [cap]: '23456' },
      { ...defaults, [`${prefix}FeesEnabled`]: true, [`${prefix}FeeMaxTotalWei`]: '23456' });
    for (const value of ['TRUE', '1', 'yes']) check({ [flag]: value }, {}, undefined, flag);
    for (const value of ['0', '-1', '01', '1.5', '0x10', 'invalid']) check({ [cap]: value }, {}, undefined, cap);
  }
  check({ EEZ_UI_L1_FEES_ENABLED: 'true', EEZ_UI_L2_FEES_ENABLED: 'true',
    EEZ_UI_L1_FEE_MAX_TOTAL_WEI: '12345', EEZ_UI_L2_FEE_MAX_TOTAL_WEI: '67890' }, {}, {
    l1FeesEnabled: true, l2FeesEnabled: true, l1FeeMaxTotalWei: '12345', l2FeeMaxTotalWei: '67890',
  });
  console.log(JSON.stringify({ passed: true, scenarios, image }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
