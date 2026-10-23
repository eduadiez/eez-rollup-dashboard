# Bidirectional treasury initiation and existing L1 Safe setup — 2026-10-21

New treasury setup requires an existing Chiado Safe address. The selected wallet
still deploys the application contracts and contributes tokens through ordinary
ERC-20 approval/funding; it does not become the imported Safe's owner. Owners,
threshold, implementation and existing assets are retained. New EEZ-X Safes use
`L1Owners`; importing an EEZ-X Safe retains the explicit owner-adoption review.

`BidirectionalTreasuryPolicy` accepts SafeL2 or the registry-authenticated L2
proxy of SafeL1 (origin 0). L1 initiation signs SafeL1's own chain/domain/nonce,
uses normal EOA signatures, and submits to its policy alias via L1 Composer.
L2 initiation keeps live L1 owner verification and the contract-signature wrapper.
Both entry points use the same allowances, bridge routes and shared budget.

The UI exposes the initiating Safe independently of the recipient chain, clears
approvals after source changes, and persists the source in payment history and
recovery identity. An L1 success is only settled after matching its Safe receipt
with canonical L2 `L1PaymentAuthorized` and payment events. The marker binds the
post-increment Safe nonce and payment calldata. Receipt or queue status alone
cannot establish settlement.

Compatibility preserves the current setup. Existing journals keep their exact
policy bytecode in `contracts/legacy/artifacts/TreasuryPolicy.json`; pending
calldata and signatures are not regenerated with a different policy. New journals
carry `bidirectional: true`; manifests without `l1Initiation` remain L2-only.
Existing immutable policies require a new policy and explicit allowance setup;
no active counter, grant, deployed contract or wallet state was silently changed.
Do not resume a new journal with an older UI that cannot interpret that flag.

## Source and validation boundaries

- Dashboard base: `0d26cf24d2fa23de31021d1a508f137e24804efd`, with existing dirty
  application work preserved. All implementation and evidence are dashboard-owned.
- Core: `855fe0602484750861b4c31502a1a91355d33ed6`; Safe:
  `bf943f80fec5ac647159d26161446ac5d716a294`; AllowanceModule:
  `c95f03900bff99be090dadb9de1c74b162365485`.
- Native runtime base: `fa916b13254a36423cad130080dde367bb18a7d6`. The runner records
  the actual dirty-source inventory and verifies binary/harness hashes before
  reuse. No runtime source, protocol pin, operator key or running node was changed.
- The shared node/signer run a different revision from the private source-based
  fixture. Private integration does not establish public-chain compatibility or
  complete a human wallet-extension/Safe-app rehearsal. No public-chain deployment
  or payment was broadcast for this change.

## Checks

- Baseline: an actual selected test of the old policy's L1 entry failed with
  Safe `GS013`. The earlier zero-test selection is retained and is not coverage.
- Solidity: 100 tests passed with no failures/skips, including both initiating
  Safes, both destinations, independent global cap, forged callers, signature
  replay, and invoice rollback after earlier legs. Formatting and browser artifact
  identity checks passed. The base policy's full suite also runs against the new
  implementation.
- JavaScript: 327 tests passed, none skipped. New tests cover source-specific
  signatures and domains, nonce snapshots, persisted intents, matched L1/L2
  settlement, lost responses, missing/reorged evidence, fee settings, and policy
  artifact compatibility. TypeScript/Vite and Docker builds passed; the existing
  Vite chunk-size warning remains.
- Real Safe configuration on two owned Anvils passed: preserved owners/threshold,
  owner adoption, separate submitter, saved signatures, implementation/Guard
  checks, and late-failure rollback. This focused suite installs protocol
  prerequisites as fixtures and uses real checkpoint transactions for inclusion
  checks; it does not claim full EEZ setup coverage.
- Read-only browser smoke passed against the local UI, including required L1
  address, six-step fresh fixture plan, unchanged imported quorum, legacy/pending
  resume, transaction history, restart, separate faucet, mobile widths and
  keyboard focus. The injected wallet blocks signatures and sends; Safe and asset
  observations are controlled fixtures. No user's browser storage was modified.

The final native four-route run passed with the corrected fixture configuration:
L1→L2 (110, split 10+100), L1→L1 (10), L2→L1 (10), and L2→L2 (20) reached the
shared 150 cap. A subsequent L1 payment was rejected with L1 allowance still
available; replay and forged-caller checks also passed. The native harness
verified posted attestation inputs and independent follower convergence.
`evidence.json` records exact source, executable, transaction and replay hashes.
The full browser run passed with no skipped scenarios. It verified owner updates,
invoice rollback and preparation rejection, the 40 / 110 / rejected-1 sequence,
the natural epoch reset, the 10% rule, a split to EEZ-X, payment history recovery,
and a final L1-origin payment to EEZ-X. Source changes cleared approvals, both
owners signed the L1 Safe domain, reload recovered the submitted intent, and
actual mined post-before-source order and independent replay were checked.
The native harness verified canonical convergence and the posted attestation.
The browser used an injected EIP-1193 test provider with genuine fixture-key
signatures; wallet-extension and public-network rehearsal remain unverified.
The changed Rust harness passed `rustfmt --check`; Python/Node syntax and
`git diff --check` also passed.

## Retained diagnostic failures

The first native run stopped at an old fixture status endpoint. This pinned
runtime exposes `eez_getCrossChainTransaction` on the L2 node, while the shared
runtime uses Composer. A loopback-only test adapter now routes just that read-only
method; discovery and submissions retain their original source Composer. A later
browser run exposed one remaining diagnostic call, corrected the same way.

Another run settled all four routes, then the replay-negative test incorrectly
waited for a Composer rejection. Invalid L1 owner signatures fail before the EEZ
call and can be mined as ordinary failed transactions. The corrected check asserts
canonical failed receipt, Safe `GS026`, unchanged Safe nonce and treasury state;
it does not claim the submitter's gas or nonce was restored.

An execution-pass run was rejected by the runner because application files were
still changing. It is retained as diagnostic evidence, not accepted fixed-source
validation. A reuse attempt of that unverified run was correctly refused. Final
runs use the previously verified artifact source with application files held fixed.
Initial test-fixture ABI/casing/JSON mismatches and the focused Anvil fixture's
missing receipt preconditions were corrected without weakening production checks.
A read-only Chromium launch failed in shared `/tmp`; task-owned temporary storage
resolved that environment failure.

The full browser run reached its final L1-initiated payment but the source Safe
transaction reverted canonically. The pinned native bundle endpoint forwards
transactions into a fee-ordered mempool. After the natural ten-minute budget
reset, the posting fee estimator had fallen below the fixture wallet's source
tip. A separate owned diagnostic reproduced the ordering failure with a 5 gwei
source tip: source transaction index 0 failed with Safe `GS013`, while postBatch
at index 1 succeeded. Treasury balances and counters stayed unchanged; the L1
observation height advanced. This is a retained failure, not a passing retry.

The dashboard harness now supplies the existing 2 gwei posting-priority floor,
above its ordinary 1 gwei test-wallet tip, and the browser test verifies mined
post-before-source order. This corrects this fixture's ordering precondition; it
does not add an atomic builder or establish public PBS behavior. Failure traces
are captured before teardown. The runner recompiles a changed dashboard harness
against the pinned lockfile while continuing to reuse only runtime binaries with
matching source and executable hashes; an old harness is never run for changed
harness source.

## Local deployment

Only `eez-rollup-ui-ui-1` was recreated using an image-only Compose overlay.
Runtime configuration and monitor/node/signer container identities were preserved.
Served HTML and treasury/entry bundles matched the build. Contract deployment,
allowances, active policies and the operator's chain configuration were untouched.
The local-only evidence directory is
`.runtime/treasury-bidirectional-20261021/`; retained native logs/datadirs live under
`.runtime/treasury-integration/`. These ignored paths are unavailable in another
checkout. The small sanitized evidence file records hashes and run identities.

See the [proposal](../../proposals/one-treasury-two-safes.md),
[shared-network procedure](../../runbooks/treasury-shared-network.md#initiating-a-payment)
and [native integration guide](../../../tests/integration/README.md).
