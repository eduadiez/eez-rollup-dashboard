# Treasury policy and live devnet payments — 2026-10-20

**Passed:** the hidden dashboard's live payments execute 40 USDC locally on
EEZ-X, then 110 on L1 funded by both Safes, then reject another 1 solely because
the global budget is exhausted. The L2 Safe still has 50 of allowance. Real
Composer, proof-signer and independent follower processes validate execution;
the browser collects genuine EIP-712 approvals and submits real transactions.

The six-decimal **Devnet USDC** fixture is not Circle-issued USDC. This validates
the proposal's Phase 2 routing milestone on private chains. It does not complete
reverse combined funding, rules, invoice settlement failure or the actual
wallet-extension/Safe-app rehearsal. No runtime source or operator configuration
was changed for this work.

## Identity and scope

- Dashboard branch `feat/treasury-demo`, base
  `0d26cf24d2fa23de31021d1a508f137e24804efd`, plus application changes hashed in
  [summary.json](summary.json). All implementation, scripts, tests and evidence
  live in this repository.
- Runtime `fa916b13254a36423cad130080dde367bb18a7d6`, with the preexisting local
  changes recorded by the [owner integration audit](../2026-10-20-treasury-owner-integration/runtime-source-overrides.json).
  Full runtime source-inventory SHA-256:
  `359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
  These are tested local binaries, not an unmodified release certification.
- Core `855fe0602484750861b4c31502a1a91355d33ed6`; Safe 1.4.1
  `bf943f80fec5ac647159d26161446ac5d716a294`; AllowanceModule v1.0.0
  `c95f03900bff99be090dadb9de1c74b162365485`. Core, Safe and module sources were
  not modified. Compiler settings remain in the [contract README](../../../contracts/README.md).
- Foundry 1.7.1, Node 26.7.0, Playwright 1.63.0 Chromium; native artifacts were
  built with Rust 1.95.0. Reuse verified the complete runtime inventory, protocol
  revision, unchanged Rust harness source and every executable hash. The hashes
  and reuse chain are retained in the summary.
- Native development L1 chain 1337 and L2 chain 420691, fresh loopback ports,
  genesis, public fixture wallets and disposable datadirs. No public-chain USDC
  was moved. The existing Composer-discovery adapter only translates discovery;
  it forwards actual RPC submissions without changing execution/proof validation.

`TreasuryPolicy` has one immutable canonical token, a 150-USDC global/per-payment
ceiling and a 600-second period. It verifies the wrapped mapping, requires the
L2 Safe caller and a signed epoch, reads balances/effective allowances, and fills
L1 capacity before bridging the L2 remainder. Both official grants are 100 with
the same ten-minute base. Only the official modules have Safe module authority;
the policy and alias are bounded delegates. No Guard is installed. Owners can
still administer or spend outside this policy.

## Commands and observed results

Run from the dashboard repository; see the [integration runbook](../../../tests/integration/README.md)
for prerequisites, wallet setup and owned-resource cleanup.

```bash
npm run test:contracts
npm test
npm run build
npm run test:treasury:ui -- --runtime /home/edu/Development/rollupX --reuse-run .runtime/treasury-integration/20261020T123316-yuwa5smz
forge fmt --check --root contracts
forge fmt --check --root contracts/legacy
git diff --check
```

The final browser run `20261020T124338-sqpjukt1` selected one native test and
passed in 193.08 seconds. Its recorded application-source hashes all
match the final files, including the idle-period and failure-test regressions. It first reran the connected owner scenarios, including
addition/removal, invalidated approvals, wallet cancellation, reload and recovery
of a lost response after a real broadcast. Three Safe configuration transactions
consume the initial L2 Safe nonces; two owner actions then reach nonce 5.

| Payment | Canonical L2 block | Safe balances L1 / L2 | Allowance spent L1 / L2 | Global spent | Safe nonce |
| --- | ---: | --- | --- | ---: | ---: |
| 40 locally on EEZ-X | 175 | 300 / 110 | 0 / 40 | 40 | 6 |
| 110 to L1, split 100 + 10 | 185 | 200 / 100 | 100 / 50 | 150 | 7 |
| Another 1 locally on EEZ-X | Rejected during composition | 200 / 100 | 100 / 50 | 150 | 7 |

Amounts are USDC. The recipient has 40 on EEZ-X and 110 on L1. The split's
100-USDC Safe transfer and 10-USDC bridge release occur in the **same canonical
L1 transaction**. Initial escrow and wrapped supply are both 150; after the split
both are 140. Policy/alias residual token balances are zero. The browser records
four wallet broadcasts: two owner actions and two payments. The rejection probe
uses a separate genuinely signed test submission.

The final rejection is checked twice: the UI refuses its review, and a signed
payment that bypasses UI preflight reaches the real Composer and reverts in the
policy. The test requires terminal `PoolDiscarded`, no receipt, a complete trace
with the policy's revert, and exact `GlobalLimit()` bytes in a direct policy
call. Both allowance counters/nonces, Safe nonce, recipient/Safe balances, global
counter, escrow, supply and temporary balances remain unchanged.

The independent follower reproduces the L2 balances, allowance, global spending
and Safe nonce at block 185, hash
`0x6bd6926e12c5d3e4dd2e5800322987751a2d166d0f6dd492ab1d3f970ef7462c`.
Canonical L1 traces verify the exact Safe signature check for each successful
action/payment. The native harness also recomputes the posted public-input hash,
verifies its attester and checks safe-prefix convergence/divergence diagnostics.
[scenario.json](scenario.json) retains the exact transaction, block, code and
state identities; [checks.json](checks.json) records supplemental checks.

The production build, 205 dashboard tests, 30 Solidity tests and syntax checks
passed. The Solidity tests include two 256-case fuzz tests. The existing mocked
browser suites passed the simulated treasury walkthrough and 16 wallet cases,
with no broadcasts. Desktop and 320-pixel screenshots were inspected. Production
build output retains the existing large-chunk warning.

The failure unit test requires the exact earlier 10-USDC escrow release and
later failing 100-USDC token call, and checks unchanged temporary balances and
both Safe nonces. All 30 contract tests passed after strengthening these checks.
The final source hashes are included in the native summary and checks.json.
The failure fixture uses synchronous single-EVM mock delivery, real Safe/module/
bridge code and a controlled false-returning token call. It establishes that
local rollback test, not a failure after real L1 inclusion.

## Corrections and retained diagnostics

- The initial reset-boundary unit test failed with `GS013`: direct reads of
  `block.timestamp` in the test were reused across `vm.warp` by the compiler.
  Using `vm.getBlockTimestamp()` in the test produced the intended new epoch.
  The original trace remains local at `/tmp/treasury-period-before.log`; the
  corrected test and full suite pass. The policy logic was not relaxed.
- `20261020T122832-hmn3faod` passed the initial complete payment integration.
  Screenshot inspection then found that after reload the locked form showed
  default fields while the settled-payment status correctly showed 110 on L1.
  The component now restores the signed fields. The final browser run adds
  explicit amount/recipient/destination/funding assertions after reload and
  passes. The passing pre-idle-fix run is preserved in
  [pre-idle-summary.json](pre-idle-summary.json) and
  [pre-idle-scenario.json](pre-idle-scenario.json). These were fixes followed by
  validation, not retry-only flaky passes.
- The idle manual devnet exposed a reset deadlock: L1 advanced to a new period
  while L2 retained an older safe block. The original reader required equal
  block epochs and prevented any new review. A regression reproduced this exact
  error before the fix (`/tmp/treasury-idle-before.log`, local-only). The reader
  now uses the current L1 epoch, applies the official module's aligned reset to
  settled allowance data, and preserves balances/grants/nonces. Both new tests
  pass, including rejection of incompatible period data. The live read-only
  browser check independently verifies a review hash bound to the new epoch
  while L2 remains at block 150 from the previous epoch. See
  [manual-check.json](manual-check.json).
- The first read-only manual page smoke check timed out waiting for navigation.
  A diagnostic reload rendered without JavaScript errors, and the later full
  readiness check passed. The startup timeout was not reproduced or assigned a
  proven cause; retain it as a manual startup flake, separate from the passing
  automated payment runs. Its local diagnostic is `manual-ui-diagnostic.json`.
- The final negative case is a composition rejection, not an inclusion rollback.
  No `L2TxSkipped` or surviving reverted token events are claimed.

Full logs, traces, executables, screenshots and failed datadirs are ignored,
**local-only** under `.runtime/treasury-integration`. Compact JSON evidence is
portable; its trace path is sanitized. Temporary unit/build logs may expire;
their digests are retained in checks.json. Successful automated fixtures shut
down their owned services; the separate manual instance is described below.

## Remaining acceptance and compatibility

The launcher adds an optional `treasury.payments` config section. Old owner-only
configs still show their connected owner flow, and a normal dashboard without
a treasury deployment still opens the simulated preview. Each fresh instance
has independent genesis/deployment identities and persisted intent storage;
an old instance's pending payment cannot be imported into the new one. The
new payment calldata includes its epoch. This is a fresh private deployment,
not a migration of an existing funded policy. Stopping/restarting the fixture
discards its disposable chain; it is not durable recovery.

Actual MetaMask/Rabby dialogs, the official L1 Safe app, a mainnet USDC fork,
public-network finality/PBS, contract-wallet owner signing and restart recovery
were not exercised. The browser uses an EIP-1193 provider backed by genuine
fixture-key signing. L1-funded combined payments to EEZ-X, rules, invoice
acceptance and controlled inclusion failure remain later proposal phases.
The UI tracks the current request; a complete browsable payment history is also
outstanding. No full Rust workspace/core matrix was rerun: protocol and runtime
sources are unchanged, and this check uses the exact native payment path with
semantic assertions and independent replay. The original scripted owner-only
suite retains its earlier evidence; the connected owner browser cases were
rerun here.

## Manual instance

The older owner-only run `20261020T120455-tq9ou3lg` was stopped through its own
stop file and exited normally. [cleanup.json](cleanup.json) verifies its RPC/UI
listeners and the completed test listeners are closed. Existing normal
services/configuration were preserved; port 8080 still has no treasury config.

Fresh payment run `20261020T123631-oy5pi0rk`, launcher PID 68601, was left running:
`http://127.0.0.1:34007/dashboard/#/treasury-demo`. Reveal with
**Ctrl+Alt+Shift+T** (macOS **Cmd+Option+Shift+T**). The run directory contains
`ui-session.json`, `public-test-wallets.json` and the generated configuration.
Use the runbook's wallet setup; a wallet's saved network must use this run's
Composer URL. The manual check only reads/reviews: no approvals or payments were
submitted, Safe balances remain 300 / 150, both grants are 100, spending is zero
and bridge backing is 150. The Vite process serves the edited sources; exact
post-fix application hashes are recorded in manual-check.json.

Stop only this instance with:

```bash
touch .runtime/treasury-integration/20261020T123631-oy5pi0rk/stop
```

This is a disposable devnet, not persistent treasury deployment or a recorded
manual wallet-extension rehearsal. A new launch creates a new chain and URL.
