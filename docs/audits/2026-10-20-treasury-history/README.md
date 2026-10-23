# Treasury payment history — 2026-10-20

Implementation is in `eez-rollup-dashboard` on `feat/treasury-demo`, preserving
existing work. Dashboard base `0d26cf24d2fa23de31021d1a508f137e24804efd`;
runtime `fa916b13254a36423cad130080dde367bb18a7d6` with its pre-existing recorded
local edits; core `855fe0602484750861b4c31502a1a91355d33ed6`. Safe 1.4.1 and
AllowanceModule 1.0.0 pins and application contracts are unchanged. All new
implementation, scripts, tests and records stay in the dashboard repository.

The [accepted increment](../../proposals/one-treasury-two-safes.md#accepted-payment-history-increment-2026-10-20)
and [runbook](../../../tests/integration/README.md#payment-history) define scope,
reconciliation and recovery boundaries. The new journal preserves submitted
identities and local funding-check rejections across new payments and reloads.
Filters and details show settled funding, rule observations and verified
rollback evidence. Generic queue removal is no longer labeled preparation
failure merely because rollback evidence is absent.

A sequential history refresh reads current canonical evidence; storage contains
no authoritative outcome cache. Unavailable/reorged evidence yields unresolved
status. History cannot unlock or resend the active request. The active recovery
key remains compatible and is migrated into history without duplicate records.
Wallet cancellation removes only the unsent attempt. Storage failure prevents
unrecorded broadcast and does not silently discard existing records.

**Validated:** 235 JavaScript tests and the TypeScript/Vite production build
passed. The full native browser run `20261020T154209-7sciw1sf` passed one test
with zero failures, ignored tests or filtered tests in 495.11 seconds. It verified
four settled payments, three preparation rejections and one rollback across
reload, with real signatures, Composer/signer execution, independent follower
replay and posted attestation verification. Details and retained earlier failures
are below. The build retains the pre-existing large-chunk warning.

The original interactive devnet was left available during validation. A fresh
interactive instance (`20261020T151413-q72r2wk7`) now loads the updated fixture
controller; its deployment and readiness checks are in [manual-check.json](manual-check.json).
No treasury payment was submitted during those checks. The normal dashboard
configuration is unchanged. Readiness checks cover the
empty journal, funded Safes, hidden navigation and 390/320px layouts.

Limitations: history is local to the browser origin and deployment, not a
chain-wide indexer. Composer diagnostics and fixture evidence can disappear on
restart; identities survive but unavailable outcomes remain unresolved. This
increment does not establish an actual wallet-extension or official Safe-app
rehearsal, Circle USDC behavior or public PBS/finality. Earlier invoice/rule
records retain their original evidence and limitations.

## Reproduction and checks

From the dashboard root:

```bash
npm test
npm run build
npm run test:treasury:ui -- --runtime /home/edu/Development/rollupX \
  --reuse-run .runtime/treasury-integration/20261020T143219-w_hh_y06
```

Artifact reuse requires that successful local run and verifies the exact runtime
source inventory, native harness and executable hashes. Without those artifacts,
follow the runbook's source-build path. The native test builds dashboard and
runtime integration contracts, creates new owned ports and datadirs, and uses
real Composer, proof signer, L1 Anvil, relay and independent follower processes.
The test wallets produce actual EIP-712/signatures and send actual transactions;
there is no browser wallet extension. No fork/runtime validation is bypassed.

The historical invoice uses 110 USDC (10 bridged from EEZ-X followed by 100 from
the L1 Safe). Its rollback is asserted against a successful earlier transfer
trace followed by the merchant error, canonical before/after state, source
reconciliation and independent replay. A separate already-closed invoice is
rejected in preparation. The payment regressions remain 40 on EEZ-X, 110 to L1,
an independent shared-budget rejection, then a natural epoch reset, 10% of
300 paying 30, and 110 to EEZ-X. The limits remain 100 per Safe / 150 globally.

The journal checks add no actual wallet broadcasts. They retain eight attempts:
four settled payments, the submitted closed-invoice preparation rejection,
two unsubmitted UI budget checks and the verified invoice rollback. Opening
older records must expose their actual split and the invoice rollback hashes
and ten before/after table rows. Reload must preserve the identities without
duplicates. Aborted read RPCs must remove verified labels until reads recover.
A wallet-declined attempt must be removed before the eventual authorized send.

Pure/mock checks cover persistence and status classification, including source
attempts sharing a Safe hash, corrupt/foreign records, storage quota failures,
hash recovery and canonical block mismatch. These do not claim a live reorg
exercise. The current increment does not rerun the unchanged 52-test Solidity
suite or the external runtime unit/core/Anvil matrices; the prior invoice audit
records their applicable contract evidence. Native execution checks the same
unchanged application contracts through both failure paths and payment routes.


## First native result and correction

Run `20261020T145049-pqh8y7r5` completed all nine owner/invoice/payment cases,
then failed the new history assertion after 692.77 seconds. The older rollback
row remained unresolved: a read-only diagnostic confirmed Composer returned
`null` for its old source hash after later canonical payments. The fixture still
retained the verified rollback report. Treating temporary queue diagnostics as
permanent request history was therefore insufficient. The first source hashes,
failure and log digest are in [first-failure.json](first-failure.json); full logs,
datadirs and screenshots remain local-only in that run.

The corrected client can retire that old request when both the submitter's source
nonce and the Safe nonce have advanced at the same canonical L2 safe block. It
rechecks that block hash after the two reads. This does not prove rollback: the
original transaction-bound trace and canonical before/after snapshots must also
verify. The report now explicitly binds the source and Safe nonces as well as
its sender, Safe hash and calldata. Missing diagnostics without canonical nonce
advancement stay unresolved. The active path still uses terminal Composer
disposition while awaiting reconciliation. No queue, protocol or signer behavior
was modified.

The fresh candidate run is `20261020T150512-ygfgfbp0`. It repeats the original
check and additionally asserts the old queue observation has expired and both
canonical nonces advanced. This is a code correction followed by a new run,
not a passing retry of unchanged code. It did not reach history acceptance because of the fixture issue below.


## Zero-tip fixture failure and correction

Run `20261020T150512-ygfgfbp0` failed the invoice evidence wait after 442.65
seconds. The existing controller tried to add `1n` to an absent decoded priority
fee. Its actual held EIP-4844 post encoded a valid zero tip; the installed Viem
parser omits zero-valued fee properties. The UI correctly withheld the rollback
claim. The failure's identities and log digest are in
[zero-tip-failure.json](zero-tip-failure.json).

The fixture now recognizes canonical RLP zero in the priority-fee slot and
represents that decoded metadata as `0n`. It rejects other missing/non-bigint
values. The separately signed closure uses a one-wei-higher tip. Neither the
original signed payload nor the complete native network envelope is rewritten.
A new regression covers both supported blob wrappers at zero tip. A reconstructed signed zero-tip fixture reproduces the old missing property and
passes the corrected decoder while preserving the signed payload hash:
[before/after diagnostic](zero-tip-check.json). The failed native envelope was
inspected before cleanup, but the fee error preceded its archive write and the
testkit removed its temporary relay directory. Those original raw bytes are
unavailable; this reconstructed check is not represented as that exact payload. This is another code correction;
no unchanged-code diagnostic retry is counted as acceptance.

Candidate `20261020T151314-jv8fnjqm` repeats the full suite with both fixes.
The updated interactive devnet described below loads this correction; the
fixture controller loads its JavaScript on startup.

Additional browser storage diagnostics: corrupt history is reported without
being overwritten, and denying access to the treasury keys disables review
without uncaught errors ([checks](storage-browser.json)). Denying **all**
localStorage access instead prevents the existing dashboard from starting in
existing application startup before treasury renders ([diagnostic](storage-diagnostic.json)).
That pre-existing application-wide storage behavior is outside this increment;
no unrelated theme/wallet/counter code was changed.


## Updated interactive instance

The current private UI is `http://127.0.0.1:46735/dashboard/#/treasury-demo`.
Reveal it with Ctrl+Alt+Shift+T (Cmd+Option+Shift+T on macOS). Its run directory
is `.runtime/treasury-integration/20261020T151413-q72r2wk7`; use that directory's
`ui-session.json` and `public-test-wallets.json`. Existing wallet networks may
need the new Composer RPC shown in **Wallet network details**. The original
interactive instance is retained for recovery of any browser-local work; its
state and recovery key were not reset or deleted.

All UI, contract and fixture source hashes match the native candidate. Since interactive startup, two validation-only files changed: the runner now checks JavaScript syntax before deployment, and the history browser helper corrects a variable name and injects missing diagnostics explicitly instead of assuming an expiry time. The deployment code is unchanged. Code and
genesis bindings pass, Safe nonce is 3, Safe balances are 300/150, allowance spent
is zero on both chains, and global spending is zero. Readiness used a fresh
browser context with an empty journal; it did not manufacture history entries
or submit payments. Hidden navigation and 390/320px layouts pass with no page
errors. The regular dashboard has no treasury configuration and retains SHA-256
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.


## Browser-helper syntax failure and early validation

Run `20261020T151314-jv8fnjqm` passed all nine transaction scenarios, including
both invoice cases, the percentage rule and both recipient chains. A read-only
check also reproduced queue pruning and successfully verified the old rollback
through canonical nonce retirement:
[real post-pruning evidence](historical-rollback-after-prune.json).

The overall run nevertheless **failed** after 1028.46 seconds: the dynamically
imported history helper declared `report` twice after its new nonce assertion
was added. It therefore never reached the final history browser assertions.
The failure and source identity are retained in
[browser-syntax-failure.json](browser-syntax-failure.json). Renaming that variable
fixes the test. The runner now checks all 16 owned JavaScript modules before
building contracts or deploying, so late dynamic imports cannot hide syntax
errors until after the settlement sequence.

A separate [UI-only check](mocked-history-ui.json) verifies all eight rendered
rows, filters, rule details, rollback table/hash expansion, 390/320px layouts and
unavailable-read downgrades using explicitly mocked outcomes in a disposable
browser context. It sent no transactions and does not establish native
settlement. The subsequent native run is described below.


## Diagnostic-retention test correction

Run `20261020T153230-22wjoedi` passed all nine transaction scenarios and the
initial history assertion: four settlements, three preparation rejections and
one verified rollback. It failed after 468.56 seconds because the new test
required the old Composer diagnostic to have expired by then. Its terminal
`PoolDiscarded` record was still present. Diagnostic retention has no fixed
expiry deadline; the test was over-specific. The result is preserved in
[queue-retention-assertion.json](queue-retention-assertion.json).

The corrected test returns `null` only for that historical invoice's
`eez_getCrossChainTransaction` lookup during reload. Receipts, source/Safe nonces,
traces, blocks and before/after state still come from the real isolated devnet.
It requires all eight outcomes to reconcile with that diagnostic absent, then
removes the override. This is explicit fault injection of nonauthoritative
diagnostic absence; it is not a claim that Composer naturally pruned the record
on that run. Actual pruning was separately observed and checked in the earlier
read-only diagnostic linked above. Product code did not change for this test
correction. Run `20261020T154209-7sciw1sf` passed the complete check, as recorded below.


## Passing native acceptance

Run `20261020T154209-7sciw1sf` passed the exact native test
`treasury_owner_quorum_settles_and_replays`: **1 passed, 0 failed, 0 ignored,
0 filtered**, in 495.11 seconds. All nine owner/invoice/payment scenarios and
the history checks completed. The final source and executable checks passed;
46 application files match the recorded hashes. Runtime/core source and
application contracts were not changed by this increment.

- [Source, tool steps and executable identities](native-summary.json): all 16
  JavaScript syntax checks, both contract builds and native execution passed.
  Verified runtime artifacts were reused from `20261020T143219-w_hh_y06`.
- [Native scenario](native-scenario.json): both destination routes, shared-budget
  rejection, rule execution, actual inclusion rollback after earlier transfers,
  distinct Composer preparation rejection, and independent canonical replay at
  L2 height 490 (`0xad1653083df6bbf64b169d32d8d55d9ce4e252dacd8f895b134d4c24074c75ef`).
  Posted public inputs/attestation were verified by the native harness.
- [History assertions](native-history-evidence.json): four settlements, three
  preparation rejections and one verified rollback; no unresolved rows at the
  end, no duplicate records, actual funding details and rollback evidence,
  reload recovery, 390/320px layouts, missing-diagnostic recovery and
  unavailable-RPC downgrade/recovery. No automatic resubmissions. The suite
  retained seven actual wallet broadcasts; history added none.
- [Local checks](local-checks.json): 235 JavaScript tests, including nine journal
  tests, rejection classification, two canonical-nonce regressions and the
  zero-tip envelope regression; production build; Python syntax; mocked
  preview/visibility checks. The zero-tip correction has unit and reconstructed
  payload evidence; the successful native fixture need not select a zero tip.

The old queue record was still present on this passing run. Its absence on
reload was explicitly injected for that one diagnostic lookup; all canonical
nonces, receipts, traces and state came from the actual devnet. Real natural
pruning was separately observed in the earlier diagnostic. Missing chain or
fixture evidence was never replaced with an asserted successful outcome.

[Final checks](final-checks.json) confirm all six known listeners from each of
the five native test runs are closed. Their logs/datadirs remain available
locally. Both interactive instances remain running intentionally, with the new
private UI ready and the original instance preserved for recovery. The normal
dashboard configuration is unchanged. The current interactive instance matches
all deployment/UI/fixture inputs of the passing run; the only two startup
inventory differences are validation-only files, listed in
[manual-check.json](manual-check.json).

The [artifact index](native-artifacts.json) records local paths and SHA-256
digests for logs, source inventory, screenshots and the invoice trace. Those
ignored `.runtime` files are local-only and are not included in another checkout.
Small JSON evidence is retained here. Earlier failed runs remain failures; each
correction and its subsequent result is recorded, rather than counting an
unchanged retry as acceptance. Documentation links, Python syntax and
`git diff --check` pass.
