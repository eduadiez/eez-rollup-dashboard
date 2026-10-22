# Reverse treasury payments — 2026-10-20

Implemented payments to EEZ-X funded by both Safes in the hidden dashboard.
`TreasuryBridge` extends the pinned test fixture with a terminal L1 lock and
local L2 mint. `TreasuryPolicy` fills the recipient chain first, spends official
allowances on both chains and retains the 100-per-Safe / 150-global setup.
The UI reviews both directions, signs in the L2 Safe domain and restores the
payment after reload. All changes are in this dashboard repository.

**Passed:** 38 Solidity tests, 208 dashboard tests, the TypeScript/Vite build,
and the full native browser integration with real Composer/proof-signer execution,
canonical L1 settlement and independent follower replay.
No production or Circle-issued assets are involved: this is Devnet USDC with
six decimals and a fixed canonical supply on private chains.

## Identity

Dashboard branch `feat/treasury-demo`, base
`0d26cf24d2fa23de31021d1a508f137e24804efd`, with existing uncommitted work preserved.
Runtime `fa916b13254a36423cad130080dde367bb18a7d6` plus the preexisting edits recorded
in the [earlier payment audit](../2026-10-20-treasury-payments/README.md).
The complete runtime source inventory SHA-256 is
`359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
Core remains `855fe0602484750861b4c31502a1a91355d33ed6`; Safe 1.4.1 and
AllowanceModule v1.0.0 remain at the [same pins](../../../contracts/README.md).
No runtime, core, Safe or module implementation was changed.

Foundry 1.7.1, Solidity 0.8.34 via IR / optimizer runs 1 and legacy 0.7.6;
Node 26.7.0, Playwright 1.63.0. Native Rust 1.95.0 artifacts are reused only after
checking the complete source inventory, unchanged Rust harness and executable
hashes against the successful prior run. Fresh L1 chain 1337 / L2 chain 420691,
genesis, loopback ports and owned process state are created for this run.

## Validation

Run from the dashboard root:

```bash
npm run test:contracts
npm test
npm run build
forge fmt --check --root contracts
forge fmt --check --root contracts/legacy
python3 scripts/run-treasury-integration.py --runtime /home/edu/Development/rollupX --ui test --reuse-run .runtime/treasury-integration/20261020T124338-sqpjukt1
git diff --check
```

Contract tests use real Safe/module/bridge contracts with synchronous delivery
between two logical managers in one EVM. Reverse tests cover 100 local + 10 L1,
L1-only funding when L2 has no balance, exact approval consumption, escrow/supply,
round-trip burn/release, wrong bridge/payer, duplicate lock nonce, malformed
receipt and missing escrow credit. A controlled lock failure must reach both
the earlier 100-USDC local transfer and 10-USDC Safe-to-alias transfer, then
revert. Recipient/Safe balances, allowance counters and nonces, Safe nonce,
global spending, deposit nonce, escrow/supply and the alias approval stay unchanged.
This establishes contract-level rollback, not failure after real L1 inclusion.

Frontend regressions cover symmetric capacity calculations, L2 signing domain,
capability checks for old deployments, both bridge bindings and reload/event
identity. The production build retains the existing large-chunk warning.

## Native process and browser evidence

Run `20261020T125820-wpm4yppo` passed its one selected native test in 712.52
seconds, with no failures, ignored tests or filtered selections. It first ran
the existing owner-management/signing scenarios, then both payment directions.
Most elapsed time after the forward payments was waiting for the next natural
L1 ten-minute boundary. No clock warp, balance injection or counter reset was
used. The reverse payment's final block and attestation were independently
validated. [summary.json](summary.json) records executable and application hashes;
[scenario.json](scenario.json) records deployments, transactions, canonical block
identities, snapshots and checks. All application hashes match the final files
and the separately running interactive deployment.

| Payment | Canonical L2 block | Safe balances L1 / L2 | Allowance spent L1 / L2 | Global spent | Safe nonce |
| --- | ---: | --- | --- | ---: | ---: |
| Pay 40 on EEZ-X | 185 | 300 / 110 | 0 / 40 | 40 | 6 |
| Split 110 to L1 | 195 | 200 / 100 | 100 / 50 | 150 | 7 |
| Extra 1 rejected by the independent global budget | Rejected | 200 / 100 | 100 / 50 | 150 | 7 |
| Split 110 to EEZ-X | 710 | 190 / 0 | 10 / 100 | 110 | 8 |

Amounts are USDC. The first two payments and rejection share one period; the
reverse payment uses the next period. Its L1 canonical batch contains the
10-USDC Safe-to-alias transfer, exact bridge approval and alias-to-escrow lock.
The L2 receipt contains both the 100-USDC local transfer and 10-USDC mint to the
same recipient. `DepositLocked` and `DepositMinted` bind nonce 0, policy/alias,
recipient and amount. L1 marks that lock consumed; L2 advances its deposit nonce
to 1. Escrow and wrapped supply increase from 140 to 150, with zero residual
policy/alias balance and zero alias approval. The recipient's cumulative holdings
are 110 on L1 and 150 on EEZ-X.

The independent follower reproduces the final L2 balances, total supply, budget
in both epochs, allowance, bridge nonce and Safe nonce at block 710, hash
`0x16265a853b12b443d5cfb6754c178b05828b29e6c544ef509fd83f9379c7a390`.
The Rust harness also verifies safe-prefix convergence, recomputes the posted
public-input hash, verifies the attester and checks divergence diagnostics.
Signer admission therefore exercised the exact mixed static/read and terminal
mutable-call path with its existing validation, without a permissive substitute.

The browser made five wallet broadcasts: two owner actions and three payments.
A separate signed global-limit probe bypassed UI preflight and was rejected by
Composer with `PoolDiscarded`, no receipt, an execution trace reaching the policy
revert and unchanged state. It is a composition rejection, not inclusion rollback.
The reverse payment survives reload with the exact amount, recipient, EEZ-X
destination and combined funding restored. Desktop and narrow layouts were
checked, with no browser page errors. The wallet is a test EIP-1193 provider
using genuine fixture-key signatures and real RPC submission, not an automated
wallet extension. [checks.json](checks.json) includes the focused checks and
corrected test-fixture issues from implementation; no native diagnostic retry
was needed.

The completed test's six RPC/UI listeners are closed; the separate interactive
instance below remains running. Full logs, receipts queried by the assertions,
trace files and screenshots are not reproduced in this compact record; raw
receipts were asserted during the run, while logs/traces/screenshots are retained
locally. Successful process fixtures remove disposable databases, so the recorded
hashes alone do not provide a persistent RPC endpoint for receipt queries.

## Compatibility and remaining scope

This is a fresh bridge pair, wrapped asset and policy deployment. Existing
wrapped tokens or escrow are not migrated or remapped. Old configuration without
`combinedL2: true` retains its former routes. New capability validation checks
both counterparts, managers, rollup, asset and wrapped mapping as well as deployed
code hashes. Stopping the fixture discards its chain; a fresh instance cannot
reuse its pending intents or wallet network/genesis identity.

Only official allowance modules have Safe module authority. No Guard is installed;
owners retain direct spending and administration. The bridge inherits the pinned
fixture's test-only initialization/admin/generic-path assumptions. Actual wallet
extension dialogs, official L1 Safe-app rehearsal, mainnet USDC, public PBS/finality,
contract-wallet owners, rules, invoice inclusion failures and complete payment
history remain outside this milestone. No full runtime/core matrix was rerun:
the exact application path is exercised with unchanged pinned native validation.

Full diagnostics under `.runtime/treasury-integration` are ignored and local-only.
Compact evidence here records the tested identities and semantic results. The
[runbook](../../../tests/integration/README.md) describes wallet setup and cleanup.

## Interactive deployment

The previous owned run `20261020T123631-oy5pi0rk` was stopped using its recorded
stop file and exited normally. Its six RPC/UI listeners are closed; see
[cleanup.json](cleanup.json). Before shutdown, the updated UI connected to its
older contracts and correctly withheld the reverse preset/funding option without
changing the Safe nonce or spending ([old deployment check](old-deployment-check.json)).
The regular dashboard on port 8080 still has no treasury configuration.

Fresh run `20261020T130157-_pacc__z`, launcher PID 133675, is available at
`http://127.0.0.1:46345/dashboard/#/treasury-demo`. Reveal with **Ctrl+Alt+Shift+T**
(macOS **Cmd+Option+Shift+T**). The run directory contains `ui-session.json`,
`public-test-wallets.json` and its own generated configuration. Use this run's
Composer URL when updating a previously saved wallet network.

The [read-only readiness check](manual-check.json) validates genesis/code and
both bridge bindings, reviews 110 to EEZ-X as 10 L1 + 100 local, checks its exact
L2 Safe hash and inspects desktop/390/320-pixel layouts. No approval or payment
was submitted. Balances remain 300 / 150, both grants are 100, all spending is
zero, Safe nonce is 3, and escrow/supply are both 150. The exact served application
hashes are retained in the check. Screenshots are local-only in that run directory.
This is not a manual wallet-extension rehearsal or a persistent deployment.

Stop only this instance with:

```bash
touch .runtime/treasury-integration/20261020T130157-_pacc__z/stop
```
