# Invoice acceptance and rollback — 2026-10-20

Implementation is in eez-rollup-dashboard on `feat/treasury-demo`, preserving
existing work. Dashboard base `0d26cf24d2fa23de31021d1a508f137e24804efd`;
runtime `fa916b13254a36423cad130080dde367bb18a7d6` plus its pre-existing recorded
local edits; core `855fe0602484750861b4c31502a1a91355d33ed6`. Safe 1.4.1 and
AllowanceModule v1.0.0 pins remain unchanged. No runtime, protocol, Safe or
AllowanceModule implementation is edited.

The typed `payInvoice` operation routes a payment to L1 then requires acceptance
by a pinned merchant. The fixture's controller opens/closes invoices and the
policy alias alone may accept their exact signed terms. Both Safes retain the
100-USDC allowance and the common 150-USDC budget per aligned ten-minute period.
The asset is private Devnet USDC, not Circle USDC. Owners retain administration
and spending outside the policy; no Guard is installed.

Local checks pass: 52 Solidity tests (including three 256-case fuzz tests), 222
JavaScript tests and the TypeScript/Vite build. The complete native browser/Composer/signer/follower run also passes; its exact source and executable identities are linked below.

The first local Solidity attempt passed 51 of 52 tests. One expectation compared
a custom-error selector against its full encoded payload; it was corrected to
assert the complete `InvoiceNotOpen(id)` bytes. The entire 52-test suite then
passed. The implementation did not change for that correction. The first type
check identified a possibly absent block observation; explicit missing-block
rejection fixed it. The current build retains the existing large-chunk warning.

The [proposal](../../proposals/one-treasury-two-safes.md#6-failure-behavior-and-rollback-evidence)
and [runbook](../../../tests/integration/README.md#invoice-failure-rehearsal)
describe the execution contract and reproducible procedure. Remaining general
demo work includes actual wallet-extension / official Safe-app rehearsal and
complete payment history. Public PBS/finality and Circle USDC are not exercised.


## Initial native diagnostic

Run `20261020T142619-bg23lfji` failed in the fixture before injecting the invoice
closure. Viem's installed parser recognizes the older four-field 4844 envelope;
this pinned Osaka fixture sends the five-field version-1 envelope containing
cell proofs. Passing the whole envelope to that parser produced an invalid
serialized-transaction error. The original post was released unchanged, so
this attempt does not establish rollback. The browser correctly never showed
“Rollback verified” and its explicit evidence wait failed. Logs, datadirs and
the exact envelope recovered from the parser diagnostic remain local-only in
that run. Source hashes are in its summary; the correction was made after this
failure while the browser was still waiting, so later hot-reloaded UI state is
not frozen-source acceptance evidence.

The controller now inspects the canonical signed payload for its fields/hash
and forwards the original complete envelope byte-for-byte. A regression checks
both wrapper forms and rejects unsupported versions. No sidecar is rebuilt and
no protocol/signature validation is bypassed. Fixture errors close the invoice
normally before releasing a held post, so a failed injection cannot silently
become an intended successful payment. Such an attempt remains unverified.


## Canonical invoice evidence

The corrected run `20261020T143219-w_hh_y06` reached both required failure
outcomes through the UI. At L1 block **39**, the independently signed invoice
closure precedes the unchanged proved post in the same target block, with the
original parent preserved. The compact [receipt and trace evidence](invoice-evidence.json)
records the following order:

1. A 10-USDC transfer from bridge escrow to the recipient returns true.
2. A 100-USDC transfer from the L1 Safe to that recipient returns true.
3. The policy alias's exact invoice acceptance call reaches `InvoiceNotOpen(id)`.
4. Their shared execution frame reverts. Its committed rolling hash no longer
   matches the successful composition; `L2TxSkipped(1, RollingHashMismatch())`
   survives in this run's posting receipt.

The posting transaction itself has **status 1**: its earlier anchor entry
succeeds, while the invoice entry is skipped. Posting receipt success therefore
does not establish payment success. The UI does not require a skip event; it
requires the common reverted trace, canonical before/after observations and
terminal source reconciliation. Composer ends this source with `PoolDiscarded`,
with no canonical L2 receipt. The independent follower reproduces the same
canonical state and absence of the source transaction.

| Observation | Before | After |
| --- | ---: | ---: |
| L1 Safe USDC | 300 | 300 |
| EEZ-X Safe USDC | 150 | 150 |
| Recipient on either chain | 0 | 0 |
| L1 escrow / wrapped supply | 150 / 150 | 150 / 150 |
| L1 allowance spent / nonce | 0 / 1 | 0 / 1 |
| EEZ-X allowance spent / nonce | 0 / 1 | 0 / 1 |
| Shared spending | 0 | 0 |
| L2 Safe nonce | 5 | 5 |

Policy/alias balances, exact approval and the L1 Safe nonce are also unchanged.
The separately closed invoice remains closed and unpaid. Network fees and EOA
transaction nonces are not part of the payment rollback guarantee. UI reload
recovers the exact signed invoice and displays this evidence. A second, already
closed invoice reaches the merchant REVERT during Composer admission and is
shown as preparation rejection, without a rollback claim.

The original native envelope and full call trace remain local-only in the run
directory. The compact evidence above is retained in this checkout. The full suite's final signer/public-input and regression results are recorded below.

## Interactive deployment and compatibility

The fresh interactive run is `20261020T143356-blh2sl33`, with URL and read-only
readiness evidence in [manual-check.json](manual-check.json). Its Safes hold
300 / 150, both allowances are unused, global spending is zero and Safe nonce
is 3. No invoice or payment was submitted during the readiness check. Deployed
code, genesis, merchant/token/policy-alias bindings and invoice calldata were
checked; the 110-USDC preview derives 100 from L1 and 10 from EEZ-X.

The invoice control is visible only on this capability-bearing deployment and
still requires the existing hidden-navigation key combination. Desktop and
390/320-pixel layouts have no horizontal overflow or browser errors. A scrolled
320-pixel viewport capture confirms readable form fields; full-page captures
can omit offscreen form text in this browser. Missing instance headers and a
foreign browser Origin are rejected with HTTP 403 before any fixture operation.

The [old-deployment check](old-deployment.json) confirmed that old contracts
hide invoice controls and keep their unchanged state. Its recorded stop file
then triggered [normal cleanup](cleanup.json), closing all six owned listeners.
The [ordinary dashboard check](normal-dashboard.json) retains the same config
hash and no treasury configuration. The new manual session is intentionally
not counted as a passing automated run; serve-mode summaries remain unverified.

No core-wide runtime matrix was rerun: protocol and runtime source identity is
unchanged. Native validation covers this application with real proof signing,
canonical settlement and independent replay. Actual wallet extensions, the
Safe app and public PBS ordering/finality are outside this local test; the
browser uses genuine signatures through the existing test EIP-1193 provider.


## Full regression completion

Run `20261020T143219-w_hh_y06` passed the one selected native test in **498.34
seconds**, with 0 failed, ignored or filtered out. The [summary](summary.json)
records exact binaries, source inventories and command results; the
[scenario](scenario.json) retains all nine scenario records. The
[checks](checks.json) confirm all **40 application source hashes** still match
both the successful run and the fresh interactive deployment. Runtime source
inventory SHA-256 remains `359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.

After both invoice cases, the existing 40 / 110 / rejected 1 sequence passes.
The suite waits for a natural ten-minute reset, pays 10% of the remaining
300 holdings as 30 on L1, then pays 110 to EEZ-X with 100 local and 10 from L1.
The final 16-USDC rule is rejected with only 10 global remaining. Final treasury
balances are 160 / 0, allowance spending 40 / 100 and shared spending 140.
Both owner actions, four successful payments and the failed invoice use genuine
browser-requested signatures; there are seven wallet broadcasts in total.
The separately forced preparation failures use genuine Node-side fixture
signatures to reach Composer despite advisory UI checks.

The native harness verifies final safe-prefix convergence at L2 block
**495**, hash `0x649d108e0f0a3b4c75624b5eaf22c34ea382ef311ff7885c875428db45e5295c`,
independently recomputes the latest posted public inputs and recovers the
attester, and checks Composer/follower divergence diagnostics. All six test-owned
listeners close normally. The separate manual deployment remains active; the
ordinary dashboard configuration hash is unchanged. No source edits or skipped
validation are used to convert the first failed native attempt into this pass.

Final local checks: 52 Solidity tests, 222 JavaScript tests, production build,
main/legacy Foundry formatting, Python/Node script syntax and `git diff --check`.
The initial parser and assertion/type diagnostics remain documented above and
in [first-failure.json](first-failure.json); the passing full run is on the
corrected implementation. No wallet-extension or official Safe-app rehearsal is
claimed by these checks.
