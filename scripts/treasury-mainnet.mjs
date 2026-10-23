// Read-only preflight. This command never loads keys or sends transactions.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseTreasuryConfig, TreasuryClient } from '../src/lib/treasury/client.ts';
import { mainnetPreflight } from '../src/lib/treasury/mainnet.ts';
const { values } = parseArgs({ options: { manifest: { type: 'string' }, template: { type: 'string' }, output: { type: 'string' } } });
try {
  if (values.template) {
    if (values.manifest || values.output) throw new Error('--template cannot be combined with --manifest or --output');
    const template = readFileSync(new URL('../docs/runbooks/treasury-mainnet.example.json', import.meta.url));
    writeFileSync(values.template, template, { flag: 'wx', mode: 0o600 });
    console.log('Mainnet template created. Replace the placeholders with independently reviewed deployment bindings.');
  } else {
    if (!values.manifest) throw new Error('Use --manifest PATH [--output PATH], or --template PATH to create an unconfigured example');
    const config = parseTreasuryConfig(JSON.parse(readFileSync(values.manifest, 'utf8')));
    const report = await mainnetPreflight(new TreasuryClient(config));
    const text = JSON.stringify(report, null, 2) + '\n';
    if (values.output) writeFileSync(values.output, text, { flag: 'wx', mode: 0o600 });
    console.log(text);
  }
} catch (error) {
  // RPC error strings can contain provider URLs; keep diagnostics local and short.
  console.error(`Mainnet preflight failed: ${String(error.message).replace(/https?:\/\/[^\s"']+/g, '[RPC URL]').slice(0, 400)}`);
  process.exitCode = 1;
}
