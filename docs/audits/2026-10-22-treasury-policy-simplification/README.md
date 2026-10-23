# Treasury policy consolidation

## Scope and source identity

The user requested the simplest implementation that preserves current features.
Work began at dashboard commit `a96bc5cd3e7df91ac585ce7cdf6303f82fc7bfb6`, on
`codex/treasury-demo-release`. A pre-existing local notice edit in
`StandardBridgeTreasuryPolicy.sol` was preserved. The accepted scope is recorded
in the [proposal](../../proposals/one-treasury-two-safes.md#accepted-feature-preserving-simplification-2026-10-22).

The protocol remains `855fe0602484750861b4c31502a1a91355d33ed6`, Safe remains
`bf943f80fec5ac647159d26161446ac5d716a294`, and Safe modules remain
`c95f03900bff99be090dadb9de1c74b162365485`. Native rehearsals use the unchanged
runtime `fa916b13254a36423cad130080dde367bb18a7d6`; the runner verifies exact
source and executable inventories before reusing binaries. No protocol or
runtime change is included.

The new immutable deployment/source build is
`facdeca2712465daf5ea77052c6d4b71547d454ae83ad6b78aa9c03c11f77424`.
Its 18 packaged contracts reproduce their retained verification inputs.

## Implementation

- `TreasuryPolicyBase` owns Safe authorization, the reentrancy boundary, aligned
  allowance checks, shared accounting, exact allocation, percentage rules and
  payment events. It is abstract and needs no separate deployment.
- `TreasuryPolicy` retains Chiado's alias lookup and terminal lock/mint bridge
  calls. `StandardBridgeTreasuryPolicy` retains the bounded Ethereum delegate
  and standard bridge callback route. Both support either signing Safe and
  either destination; Chiado still permits direct EEZ-X submission.
- New policies expose only `paySplit` and `payRule`. A single-Safe fixed payment
  uses zero for the other contribution. Signed allocations never silently change
  when capacity changes; percentage rules still read and route at execution.
- Constructor-only bidirectional/split wrappers and executable policy-upgrade
  contracts were removed. Setup directly deploys the simplified policy. Read-only
  historical receipts and immutable release inputs remain available; existing
  saved journals retain their original deployment bytecode.
- The existing test token, faucet, internal transfers, owner management, payment
  history and shared infrastructure remain unchanged. Invoice behavior stays in
  isolated test fixtures, outside both public policy variants.

The six original policy/wrapper/upgrade source files totalled 822 lines; the
common base and two adapters total 375. Runtime sizes changed from 10,683 to
11,147 bytes for the Chiado policy, and from 10,238 to 8,737 for the standard
policy. This is a maintenance simplification, not a claim of universal gas or
bytecode reduction. The removed inheritance wrappers were not separate deployed
instances, so their removal does not eliminate wallet confirmations.

These contracts are immutable. New setup uses the new release; an already
installed policy does not change in place. Historical bundles are not rewritten.
There is no automatic migration or Safe/fund movement.

## Local validation

| Check | Result |
| --- | --- |
| Baseline JavaScript / Solidity | 449 / 236 passed before refactoring. |
| `npm test` | 445 passed, none failed or skipped. Four executable upgrade-workflow tests were removed; historical record tests remain. |
| `forge test --root contracts` | 141 passed, none failed or skipped. Removed obsolete upgrade cases and duplicate executions inherited through the deleted wrappers; active feature assertions remain. |
| `forge fmt --check --root contracts` | Passed. |
| `npm run check:treasury-release` | Exact compiler inputs, source pins and all 18 deployment artifacts agree. |
| `npm run build` | TypeScript and Vite passed; existing chunk-size warnings remain. |
| Edited integration script syntax | Node and Python checks passed. |
| `node tests/integration/treasury-deployment-batches.mjs` | 19 cases passed against the new release, including shared infrastructure reuse, empty-balance setup, both split destinations, independent budgets and repeatable faucet requests. |
| `node tests/integration/treasury-source-verification.mjs` | Six real local creations verified with exact recompilation and persistent restart recovery. Explorer transport is controlled. |
| `TMPDIR=<owned directory> node tests/treasury-mainnet-setup-browser.mjs` | Selected Safe addresses and connected wallet respected; mainnet faucet hidden; Chiado journals preserved. |

The setup integration models two logical chains on one owned Anvil with real
Safe, allowance, bridge and token contracts. It is not Composer/proof validation.
Native settlement evidence is recorded separately below. Controlled explorer
responses do not establish acceptance by a public explorer.

## Native settlement and browser validation

The serial standard-bridge run `20261022T223230-n4c03kfm` passed, including
final runtime/application source-integrity checks. It cloned the retained real
bridge and USDC runtime bytecode into fresh local state. No public balances or
public transactions were used.

Eight scripted cases covered the 40 / 110 / rejected-1 sequence, all signing
origin/destination combinations, exact allocations and the combined-balance rule.
The browser collected genuine fixture signatures, relayed once through Ethereum,
and recovered after reload and loss of the wallet response. A separate native
follower replayed the settled state, and the final posted attestation was verified
against independently recomputed public inputs.

For rollback, a controlled blacklist transaction preceded the original signed
payment at inclusion. The original proof and blob commitments were retained.
The canonical trace proved an earlier successful release followed by a rejected
token transfer. Before/after checks covered balances, escrow and supply,
allowance counters/nonces, shared spending, Safe nonces and temporary custody/
approvals. Composer reached terminal source-reverted disposition.

```bash
python3 scripts/run-treasury-integration.py \
  --runtime ../rollupX \
  --reuse-run .runtime/treasury-integration/20261022T215319-xkpfpui0 \
  --standard-bridge-snapshot .runtime/treasury-integration/20261022T215319-xkpfpui0/mainnet-snapshot.json
```

The snapshot and reusable binaries are local-only. A fresh checkout must follow
the [mainnet rehearsal procedure](../../runbooks/treasury-mainnet.md) to prepare
its own inputs; the runner refuses mismatched sources or executable hashes.

The final Chiado-bridge browser run `20261022T232301-x9nfvso5` passed all
scenario, source-integrity and native verification checks. It covered owner
addition/removal, genuine fixture signatures, wallet cancellation, lost-response
and reload recovery, exact splits to both chains, the natural ten-minute reset,
the 10% combined-balance rule and independent shared-budget rejection.

History verified four settlements, three preparation rejections and one rollback,
including reload with deliberately omitted old Composer diagnostics, unavailable
RPC recovery and mobile layouts. The final payment began at the L1 Safe, invalidated
approvals when its signing origin changed, settled once and survived reload.
An independent follower reproduced canonical height 460 and hash
`0x2d34f48007c9b3b2e5e6864c91496938027b2688b327c7f0f886383d2341db09`;
the posted attestation was independently verified. The native target selected
one test and passed; it did not skip or ignore any case.

```bash
python3 scripts/run-treasury-integration.py \
  --runtime ../rollupX \
  --reuse-run .runtime/treasury-integration/20261022T223230-n4c03kfm \
  --ui test
```

These are passes after the failures and corrections below, not first-attempt
passes. The browser uses a controlled EIP-1193 provider with real fixture-key
signatures and real RPC submission, rather than automating a wallet extension.

## Failures retained

The initial compiler check caught test imports of wrappers being removed. Tests
were moved to the common payment fixture. The first application build caught the
missing optional `verification` field in the existing artifact type; that type
now reflects the retained release data. Corrected builds and tests passed.

The first standard-bridge run (`20261022T221958-xopjgxa0`) passed scripted
payment routes and percentage rules, then Chromium crashed. Its diagnostic
cleanup replaced the original error and left the scenario process waiting; that
owned process was stopped to release its native devnet. The concurrent Chiado
run (`20261022T222431-amjlwwn9`) timed out during setup settlement. Host observations
showed only 1.4 GiB available memory and exhausted swap, with unrelated builds
and devnets running. These are failed runs, not successful native validation;
memory pressure is a possible contributor, not a proven root cause.

The browser harness now preserves the initial error if screenshot/DOM inspection
fails and closes both browser and server even after a renderer crash. Rehearsals
are repeated serially with their assertions unchanged. A later retry pass does
not erase these flaky first attempts. Logs and datadirs are retained locally.

A subsequent UI attempt (`20261022T223703-budf067q`) was intentionally stopped
during setup: static review found that its later forced global-budget rejection
still encoded the removed `pay` method. It now signs `paySplit` with a zero L1
contribution, exactly as the UI does. The explicit `GlobalLimit` selector, source
disposition and unchanged-state assertions remain. That aborted run is not
counted as completed validation.

The next run (`20261022T223824-ij_587ur`) settled the first browser owner action,
then unexpectedly returned to the initial payments view. Retained browser logs
showed blocked HMR websockets. Route teardown then raised `Route is already
handled`, obscuring the original assertion. Automated UI mode now disables HMR;
interactive devnets retain it. The harness records unexpected routing failures,
closes the browser without forwarding in-flight requests again, and prints the
original assertion before cleanup. It retains zero HTTP submission retries and
checks for routing errors before accepting a pass.

With the original failure visible, `20261022T224333-4a87gn12` passed both owner
addition/removal actions and failed the invoice helper's immediate enabled-button
assertion after opening the payments view. That view first validates the deployment
and reads balances asynchronously. The invoice/payment helpers now use the
existing bounded polling helper to require automatic readiness, instead of
sampling the intermediate loading state. Pending-action rejection and all
on-chain assertions remain unchanged.

Run `20261022T224730-x7tfxybx` verified actual invoice rollback after both L1
transfers and separately verified closed-invoice rejection during composition.
Its UI assertion then exposed a status-card bug: hiding all terminal status text
also hid the rejection explanation. The card now retains that explanation for
rejected payments; the existing visibility assertion is unchanged. TypeScript,
Vite and application regressions were rerun after this one-line display fix.

Run `20261022T225300-g62b3kpl` passed that rejection assertion, then failed a
payment-reload check against the removed Funding select. The check now verifies
the restored slider percentage and exact 100/10 or 10/100 token contributions;
rules have no fixed-allocation slider. Review of the remaining script also
updated its expected wallet sends to seven (two owner actions, four L2 payments,
one L1 payment; invoice attempts use the fixture submitter) and explicitly selects
available funds for the final L1-origin payment. All amount, replay, history and
no-duplicate-submission assertions remain.

Run `20261022T225903-edn4uv63` passed both owner actions, invoice rollback,
four payments in both directions and the independent budget/rule rejections.
History then remained unresolved after old Composer diagnostics expired. The
invoice fixture used a dedicated sender, while later successful browser payments
used an owner; only the Safe nonce advanced. Missing diagnostics correctly require
both canonical nonces to advance before retiring a request. The rollback fixture
now uses that later browser sender; production retirement and rollback validation
are unchanged. The diagnostic-omission check now intercepts the Composer endpoint
and asserts that the missing lookup was actually exercised.

Run `20261022T231508-kvjr3oyj` confirmed rollback with the browser sender, then
failed the preparation-rejection trace wait. The native diagnostic filter selects
the dedicated fixture sender, so changing both invoice senders excluded the second
case's trace. Read-only diagnostics confirmed terminal `PoolDiscarded` and no
canonical receipt; those observations do not replace the trace assertion. The
preparation case again uses the filtered sender, while only the historical
rollback case uses the later browser sender. The native filter and assertions
remain unchanged.

## Evidence and limits

Local evidence is under `.runtime/treasury-simplification-20261023/`,
`.runtime/treasury-deployment-batches/anvil-JDwJ08/` and
`.runtime/treasury-auto-verification-20261022/anvil-lqEEme/`.
These ignored paths are not present in another checkout. The accompanying
[results](results.json) retain source identities, outcomes and file hashes.

No public-chain transactions, service restarts, wallet funding or new environment
variables are part of this change. Existing environment/network files and
historical release bundles were checked against their initial contents. Public
wallet-extension/Safe-app acceptance and independent contract review remain
outside this isolated validation. The custom contracts remain demo code.
