# Percentage treasury payments — 2026-10-20

The dashboard-owned policy and hidden UI now support a percentage of both Safe
holdings, defaulting to 10%. Owners sign the fraction, canonical asset, recipient,
destination, period and Safe nonce. Execution reads both balances and uses the
existing destination-first router and 100-per-Safe / 150-global allowance setup.
The review labels its amount as an estimate; settlement requires matching
`RulePaid` observations and `Paid` funding, with the calculation checked again.

**Passed:** 49 Solidity tests, 217 dashboard tests, the TypeScript/Vite build
and the full native browser/Composer/signer/follower scenario. An initial test
assertion failure and its correction are retained below; the corrected source
passed the complete sequence on a fresh devnet.

All implementation, tests and records live in eez-rollup-dashboard. No runtime,
core, Safe or AllowanceModule implementation is changed. Only official modules
have Safe module authority; owners retain direct administration and spending.
The private asset remains six-decimal Devnet USDC, not Circle-issued USDC.

## Scope and identity

Dashboard branch `feat/treasury-demo`, base
`0d26cf24d2fa23de31021d1a508f137e24804efd`, preserving existing uncommitted work.
Runtime `fa916b13254a36423cad130080dde367bb18a7d6` plus its previously recorded local
edits; complete source inventory SHA-256
`359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
Core `855fe0602484750861b4c31502a1a91355d33ed6`, Safe 1.4.1 and AllowanceModule
v1.0.0 at the [unchanged pins](../../../contracts/README.md). Foundry 1.7.1,
Solidity 0.8.34 via IR / optimizer runs 1 and legacy 0.7.6; Node 26.7.0,
Playwright 1.63.0. Rust 1.95.0 native artifacts are reused only after source,
harness and executable identity checks against a successful prior run.

## Contract and frontend checks

`npm run test:contracts` passes 49 tests, including three 256-case fuzz tests.
New cases cover precise rounding, zero and 100% boundaries, invalid fields,
insufficient capacity without clipping, excluded escrow/policy/alias holdings,
full-precision intermediate multiplication, shared counters, and rule routing
to either destination using both Safes. A signed rule executes against a changed
balance after an ordinary L1 Safe owner transfer, proving it authorizes a fraction.
A later transfer failure must reach the earlier bridged contribution and then
restore recipient balances, allowances/nonces, Safe nonce, supply and spending.
That fixture uses synchronous delivery in one EVM; it is not L1 inclusion-failure
evidence.

`npm test` passes 217 tests. New coverage checks percentage precision, immutable
signing fields, old-manifest compatibility, deployment denominator binding,
reload recovery, exact actual-event calculation and rejection of missing,
duplicate or inconsistent rule/payment events. The TypeScript/Vite build and
contract formatting pass; the build retains its existing large-chunk warning.

## Compatibility and limits

A fresh isolated deployment advertises `percentageRules: true`; the UI checks
its code identity and denominator before enabling rules. Old configurations
retain fixed payments and hide the new controls. Fixed saved intents remain
readable; rule intents store the signed fraction and deployment identity.
Restarting this fixture deploys fresh Safes/assets/policy and does not migrate
old escrow or reuse pending submissions. No operator configuration is rewritten.

The amount is `floor((balanceL1 + balanceL2) * bps / 10000)`. Only Safe holdings
count. Fractions range from 1 to 10000 bps; zero-rounded or over-limit amounts
and insufficient capacity reject the whole payment. Normal balance changes can
change the result under an already signed fraction; its epoch and policy limits
still apply. The UI shows actual execution observations after settlement.

Actual wallet-extension dialogs, the official Safe app, Circle USDC, public
PBS/finality, contract-wallet owners, invoice inclusion failure and complete
payment history remain outside this milestone. No full runtime/core matrix is
rerun because the pinned native implementation is unchanged. The native test
covers the exact application path with independent proof and replay checks.

## Owned deployment handling

The previous interactive run `20261020T130157-_pacc__z` was checked with the new
UI before shutdown: it retained fixed/reverse payments and hid rule controls,
with Safe nonce 3 and zero spending. Its recorded stop file then triggered normal
fixture cleanup; all six listeners closed. [Compatibility](old-deployment-check.json)
and [cleanup](cleanup.json) checks preserve that result. Manual serve mode
intentionally records `verified: false`; normal cleanup is not a full test run.
The [ordinary dashboard check](normal-dashboard-check.json) confirms port 8080
still serves the same configuration without a treasury deployment.

## Reproduction

Run from the dashboard root:

```bash
npm run test:contracts
npm test
npm run build
forge fmt --check --root contracts
forge fmt --check --root contracts/legacy
python3 scripts/run-treasury-integration.py --runtime /home/edu/Development/rollupX --ui test --reuse-run .runtime/treasury-integration/20261020T125820-wpm4yppo
git diff --check
```

The reuse directory is local-only. On another checkout, use the [runbook's normal
build command](../../../tests/integration/README.md#browser-integration), without
`--reuse-run`. Successful fixtures delete disposable chain databases; full logs,
traces and screenshots remain under the ignored run directory. Compact repository
JSON records contain the tested identities and asserted outcomes, without
claiming an indefinitely queryable RPC or durable Composer recovery.

## Interactive deployment

Fresh run `20261020T135223-if4s3eqk`, launcher PID 250072, serves
`http://127.0.0.1:37863/dashboard/#/treasury-demo`. Reveal it with
**Ctrl+Alt+Shift+T** (macOS **Cmd+Option+Shift+T**). Its `ui-session.json` and
`public-test-wallets.json` contain this instance's wallet RPC and public fixture
accounts. Update a previously saved wallet network to this run's Composer URL.

The [read-only readiness check](manual-check.json) validates deployed code/genesis
and rule capability, reviews 10% of the initial 300 + 150 = 450 as 45 for each
destination, and matches the displayed Safe hashes to their exact rule calldata.
No approval or payment was submitted. Both Safe allowances remain 100, shared
spending is zero, Safe nonce is 3, and escrow/wrapped supply are both 150.
All 34 tracked application-source hashes match the first native attempt.
The corrected attempt changes only the browser assertion file: deployed
contracts, UI and runtime sources are identical.

Desktop and 390/320-pixel layouts have no horizontal overflow or browser page
errors. The first offscreen full-page capture omitted disabled form text;
separate fresh, scrolled 320-pixel viewport captures show the percentage fields
and review correctly below the fixed navigation. Those screenshots remain
local-only in the run directory. This was a capture artifact, not a code fix.

## Initial native failure and correction

Run `20261020T134955-m641cbjr` reached the settled 30-USDC rule, including UI
reload recovery and correct Safe/recipient balances and counters. Its strict
`RulePaid` assertion compared the decoded checksummed token address against a
lowercase manifest string and failed despite identical address bytes. The
[failure record](first-failure.json) preserves the exact difference and source
hash. The failed harness source, complete log and datadir remain in that run.
This attempt is not a passing integration: rule replay, the subsequent reverse
payment and the final native checks had not completed.

The correction normalizes expected event addresses with `getAddress`; it retains
exact comparisons for their identity and every other field. No contract, UI,
runtime or protocol change was needed. The fresh full native run below passed after
this test-source correction; the first failure is not erased or counted as a pass.

## Passing native process and browser evidence

Run `20261020T140047-p_9zxi9v` passed the one selected native test in 573.77
seconds: 1 passed, 0 failed, 0 ignored and 0 filtered out. Its [summary](summary.json)
records exact executable and application-source identities; the [scenario](scenario.json)
records transactions, canonical observations, assertions and final independent
replay. [Checks](checks.json) distinguish local contract, frontend, native and
read-only readiness evidence. Test-owned listeners closed after normal cleanup;
the separate interactive instance remains running.

| Action | Canonical L2 block | Safe holdings L1 / L2 | Allowance spent L1 / L2 | Global spent | Safe nonce |
| --- | ---: | --- | --- | ---: | ---: |
| Pay 40 on EEZ-X | 175 | 300 / 110 | 0 / 40 | 40 | 6 |
| Split 110 to L1 | 185 | 200 / 100 | 100 / 50 | 150 | 7 |
| Extra 1 rejected by the independent global budget | Rejected | 200 / 100 | 100 / 50 | 150 | 7 |
| Pay 10% of holdings | 560 | 170 / 100 | 30 / 0 | 30 | 8 |
| Split 110 to EEZ-X | 570 | 160 / 0 | 40 / 100 | 140 | 9 |

Amounts are Devnet USDC. The first three cases share one period. The test waits
for the next natural L1 ten-minute boundary, without a clock warp or state reset,
then signs a rule over the remaining 200 + 100 holdings. Editing 10% to 5% after
one approval clears the approvals and changes the Safe hash; restoring 10%
requires collecting both signatures again. The resulting `RulePaid` records
1000 bps, balances 200 / 100 and amount 30. `Paid` reports 30 from L1 and zero from
L2; the canonical L1 receipt contains that exact transfer. Reload preserves the
fraction and displays actual execution observations. The follower independently
reproduces the rule receipt, global debit and Safe nonce at block 560.

The following 110-USDC EEZ-X payment receives 100 locally and 10 through the
terminal L1 lock / local mint. Its allowance spending is 40 / 100 and global
spending 140. Both epochs' counters, wrapped supply, balances, consumed bridge
nonce and Safe nonce are independently replayed at block 570, hash
`0xd2cb3deec0e67d91fba166cd44b2e8185c015b23c21319c9a60a25884d0c319e`.
The Rust harness verifies safe-prefix convergence, recomputes posted public
inputs, verifies the attester and checks divergence diagnostics. Production
signer validation remains intact, including the new rule's remote balance read.

A final rule review computes 16 from the remaining 160 holdings and rejects it
because only 10 remains globally. That last check is UI preflight; the contract
suite separately reaches its exact `GlobalLimit()` rejection. The earlier fixed
1-USDC negative case also submits through Composer, reaches the policy revert,
gets `PoolDiscarded` with no receipt, and leaves all observed state unchanged.
Neither is presented as a failure after L1 inclusion.

The browser uses genuine fixture-key EIP-712 signatures through a test EIP-1193
provider and makes six wallet broadcasts: two owner actions and four payments.
No wallet extension or official Safe app is automated. No page errors or narrow
layout overflow were observed. Native coverage exercises the rule on L1 and
the fixed payment to EEZ-X; contract tests additionally exercise rules funded
by both Safes for each destination. All final application hashes match the
passing run; only the corrected browser assertion differs from the earlier
interactive launch inventory, with all served code and deployed contracts equal.
