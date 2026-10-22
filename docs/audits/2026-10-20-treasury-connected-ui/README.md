# Connected treasury owner UI — 2026-10-20

**Passed:** the hidden Treasury Demo reads the real L1 owner set, collects EIP-712
wallet approvals, submits an EEZ-X Safe transaction through Composer, and tracks
canonical settlement. The browser scenario verifies two successful actions,
stale-approval invalidation, reload and lost-response recovery. The real proof
signer and an independent follower validate the resulting execution.

This validates the owner/signing/submission foundation. The action sets a value;
USDC, shared budgets and bridge routes remain in the separate simulated preview.
The browser uses a test EIP-1193 wallet with genuine fixture-key signatures, not
an automated MetaMask/Rabby extension. L1 administration uses normal A+B Safe
transactions from the dashboard helper. The official Safe-app and intended
wallet-extension rehearsal remain pending.

## Identity and isolation

- Dashboard: `feat/treasury-demo`, base
  `0d26cf24d2fa23de31021d1a508f137e24804efd`, plus application/test files hashed in
  [summary.json](summary.json). No runtime source was changed for this work.
- Runtime: `fa916b13254a36423cad130080dde367bb18a7d6` plus the preexisting local
  changes inventoried in the [earlier audit](../2026-10-20-treasury-owner-integration/runtime-source-overrides.json).
  The full runtime inventory digest remains
  `359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
  This does not certify an unmodified release binary.
- Core: `855fe0602484750861b4c31502a1a91355d33ed6`; Safe 1.4.1:
  `bf943f80fec5ac647159d26161446ac5d716a294`. The native executable and Rust harness
  hashes match the earlier successful integration exactly. Reuse checks every
  executable, the complete current runtime source inventory, the harness source
  and both revisions before startup. A corrupted Composer fixture was rejected
  before any devnet started.
- Node 26.7.0, Foundry 1.7.1, Rust 1.95.0, LLVM 22 and Playwright 1.63.0 Chromium.
  [Contract compiler settings](../../../contracts/README.md) remain unchanged.
- Fresh native development L1 (1337), L2 (420691), Composer, proof signer and
  follower. Each run owns its loopback ports, genesis, fixture wallets and data.
  Existing dashboard configuration, wallets and services were preserved.
- The pinned front exposes `eez_composerInfo`, not the wallet discovery virtual
  `eth_call`. A dashboard-owned loopback adapter translates only that probe,
  reading metadata, chain ID and genesis from the actual fixed upstream. It
  checks expected bindings and forwards other RPCs and signed submissions to
  that same front. Proof validation and execution are not emulated or bypassed.

## Commands and observed results

Run from the dashboard repository; [full prerequisites and manual workflow](../../../tests/integration/README.md).

```bash
npm test
npm run build
npm run test:treasury:ui -- --runtime /home/edu/Development/rollupX --reuse-run .runtime/treasury-integration/20261020T120157-zw962lte
npm run test:treasury:integration -- --runtime /home/edu/Development/rollupX --reuse-run .runtime/treasury-integration/20261020T112247-bdym7b14
```

The final browser run selected one native test and completed in 102.54 seconds:

| Browser action | Canonical result |
| --- | --- |
| B+C approve after adding C on L1; reload after submission | Value 42, Safe nonce 1, L2 block 90; exact signature check in canonical L1 block 18 |
| Prepare B+C, then remove C on L1 | Review/approvals cleared, value 42 and nonce 1 unchanged; no submission |
| A+B approve after removal; lose the response after a real broadcast | Exact Safe event recovers the hash; value 43, nonce 2, L2 block 100; L1 verification block 20 |

The browser recorded exactly two wallet broadcasts. Canceling a signature or
submission did not broadcast. The test also covers hidden navigation, network
switching, non-owner/duplicate/incomplete approvals, edits clearing approvals,
owner addition invalidating an old review, and widths 390/320 without horizontal
overflow. After reload, the status correctly says approvals were collected.
Screenshots were inspected at desktop and narrow widths.

Both success cases verify canonical L1 batch traces of the exact Safe signature
check. The final state and nonce are checked on the independent follower, whose
safe-prefix hash agrees at L2 block 100:
`0x3beea3551ce58df04e5a7ac311e6a27d1d7582f33b2bc37e9d2e4c08a35537d3`.
The native harness independently recomputes the public-input hash and recovers
the expected posted attester. No divergence-failure logs were observed.
[scenario.json](scenario.json) records transaction, block and code identities.

The original five scripted cases also passed after the shared fixture refactor:
non-owner rejection, addition, replay rejection, removal rejection, and a valid
remaining quorum. See [scripted scenario](scripted-scenario.json) and
[its identities](scripted-summary.json). Those negative cases reach the L1 Safe
through Composer and check its revert, source disposition and unchanged state;
they are composition rejection tests, not inclusion rollback tests.

Other checks passed: 199 dashboard tests; TypeScript/Vite build (existing large
chunk warning); JavaScript/Python syntax and documentation whitespace. The
production-preview browser checks passed the simulated 40 / 110 / rejected 1
walkthrough and 16 existing wallet-discovery cases, with zero broadcasts. The
unchanged contracts retain the earlier 23-test evidence, including 256 fuzz
cases; both contract projects were rebuilt for these native runs. No full Rust
workspace, protocol matrix, public-network or production PBS test was run because
this change is confined to dashboard application/tooling code.

## Failures retained and corrected

| Local run or check | Finding and resolution |
| --- | --- |
| `113631-ebc5_u73`, `113916-q5q_uokv`, `114616-k3hu32u1` | Owned builds stopped while waiting for another build's Cargo lock; no devnet started. The other build was preserved. Exact verified artifact reuse avoided that contention. |
| Multi-owner read regression | Passing `getAddress` directly to `Array.map` interpreted the index as a chain ID. Reproduced invalid checksums, then verified an explicit one-argument callback. The same test also checks the L1 block after the reads. |
| `115204-te7cozga` | Pinned Composer returned `0x` to virtual discovery. Added the local compatibility adapter and negative tests for missing metadata and mismatched genesis/bindings. |
| `115745-o3rmrxlg` | Actual Safe action settled, but the UI failed to recognize its indexed execution event. Corrected the Safe 1.4.1 event ABI. Two regressions failed with the actual topic/data layout before the fix and passed afterward. |
| `115908-2disf718` | Deliberately corrupted reuse artifact rejected before startup, as required. |
| `120157-zw962lte` | Complete browser scenario passed after the ABI fix. |
| `120430-1lisanjn` | Final browser scenario passed after clarifying the restored approval text. |
| `120013-l1aedfgy` | Original five-case scripted integration passed. |

Run directory prefixes are `20261020T` under `.runtime/treasury-integration/`.
These are diagnosed failures followed by fixes, not retry-only flaky passes.
Full logs, failed datadirs, execution traces, binaries and screenshots are
**local-only** and ignored. The compact JSON evidence here is portable; its
trace directory is sanitized. Completed test RPC listeners were checked closed.

## Manual session and remaining limits

A separate fresh session was started with `--ui serve`:
`20261020T120455-tq9ou3lg`, launcher PID 4172130. Its URL at creation was
`http://127.0.0.1:34909/dashboard/#/treasury-demo`; it was left running for manual
use. `ui-session.json` records the current URL/stop file and
`public-test-wallets.json` supplies public A/B/C fixture keys. Stop only this
session with:

```bash
touch .runtime/treasury-integration/20261020T120455-tq9ou3lg/stop
```

Manual operation is not recorded as an automated pass. Relaunching creates a new
disposable chain and URL; the runbook describes wallet RPC updates. The normal
port-8080 dashboard continues to show the simulated preview.

A read-route probe cannot guarantee an extension's simulation/submission route.
Ordinary `eth_estimateGas` still cannot resolve these EEZ static reads; submission
uses the tested explicit gas ceiling. Public-network finality, production relay
ordering, contract-wallet owners, shared budgets, bridge payments, invoice
rollback and durable recovery after runtime restart were not tested. Missing
receipts/queue history remain unresolved in the UI and never trigger an automatic
resubmission. The accepted scope remains the connected owner-verification demo.
