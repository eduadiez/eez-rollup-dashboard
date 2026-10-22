# Treasury setup simplification — 2026-10-20

The shared dashboard setup now retains confirmed deployments, reuses pinned
Safe infrastructure where its exact code exists, and batches each Safe's
remaining configuration. The observed new/new Chiado/EEZ-X plan has **23 total
transactions**, including a retained first Safe implementation deployment,
versus the previous 31. The six allowance administration transactions become
two; the L1 batch also provisions the policy alias. An EEZ-X batch helper must
still be deployed. The normal setup omits the owner-action contract and two
invoice fixture steps. Without reusable infrastructure the fallback has 25.

All implementation and evidence are in `eez-rollup-dashboard`. No protocol,
operator credentials or configuration were changed. The user's confirmed first
transaction is reported by the user; this task does not access their browser
storage or claim to have independently inspected its transaction hash. Migration
was verified with real owned-Anvil receipts and an isolated browser journal.
No shared-chain transaction was broadcast by these checks.

## Source and compatibility

- Dashboard HEAD `0d26cf24d2fa23de31021d1a508f137e24804efd`, branch
  `feat/treasury-demo`, preserving pre-existing uncommitted work.
- Protocol `855fe0602484750861b4c31502a1a91355d33ed6`;
  Safe `bf943f80fec5ac647159d26161446ac5d716a294`;
  AllowanceModule `c95f03900bff99be090dadb9de1c74b162365485`.
- Official Safe deployment catalog revision
  `e9cc9798ab834e7fe515d361566eb4a28c65387f`.
- Foundry 1.7.1, application Solidity 0.8.34 with optimizer runs 1/via IR;
  unchanged Safe/Allowance legacy compiler settings.
- [Changed-source hashes](sources.json) identify the exact final implementation,
  including generated browser artifacts and retained historical compatibility
  fixture. Protocol submodule worktrees were checked before builds.

The running shared protocol remains the different deployment recorded in the
[network inspection](../2026-10-20-treasury-shared-network/README.md). Its exact
proxy/implementation hashes are still checked through the dashboard's existing
profile; application imports and the isolated native test use the protocol pin
listed above. The isolated result does not establish completed deployment on the
shared network.

Chiado's canonical Safe 1.4.1 implementation/factory are absent. Its official
1.3.0 factory (`0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2`) and call-only helper
(`0x40A2aCCbd92BCA938b02010E17A5b8929b49130D`) match the pinned catalog hashes.
The factory creates a proxy whose executable body matches the pinned 1.4.1
proxy. Its different event indexing is handled explicitly. The Safe singleton
stays **1.4.1**; this change does not add imported Safe 1.3.0 account support.
Official 1.4.1 infrastructure is selected where exact code exists, including
its mainnet deployment addresses, but the dashboard remains restricted to its
existing testnet pair. Older allowance module releases are not substituted for
our pinned 1.0.0 module.

Version 3 retains the original completed prefix and all addresses, transaction
hashes, deployer and salt. Only the remaining work is transformed. Pending wallet
requests and saved Safe reviews retain their old plan until completed; reviews
are never re-signed or reinterpreted. A pre-migration journal is archived before
replacement under a salt-specific browser key. All 32 original prefix boundaries
are tested. A pending previous policy constructor is recognized only by exact
initcode hash, argument length and canonical creation receipt. Older manifests
and invoice-enabled policies still work; old UI builds cannot resume version 3.

Each batch uses zero-value CALL operations under a verified call-only helper,
executed by Safe delegatecall. The current quorum signs the entire transaction
with `safeTxGas = gasPrice = 0`. Exact Safe success events and receipt-block
allowance/module/alias state are required before advancing. Official code is
rechecked before approval/submission. Unexpected code, changed owner quorums,
nonces, missing receipts and storage failures stop progression.

## Checks and evidence

| Check | Result and scope |
| --- | --- |
| `npm test` | 267 passed; zero failed/skipped. Includes migration, storage preservation, pinned infrastructure, pending constructor compatibility and payment-only manifests. |
| `forge test --root contracts` | 56 passed; zero failed/skipped. New no-merchant policy runs the 40/110/rejected-1 sequence and explicitly rejects invoice calls. Mocked EEZ delivery. |
| `node tests/integration/treasury-setup.mjs` | Nine cases passed on two owned Anvils; [record](setup.json). Actual official factory/helper bytecode, real Safe signatures and canonical receipts; protocol discovery/identity are fixture substitutes. |
| Browser on installed UI | Passed; [record](browser.json). Actual network reads, 23-step plan, preserved confirmed journal, unchanged unresolved request, no signing/sending, desktop/mobile. Journal migration uses a synthetic fixture in an isolated context. |
| Build, generated artifact check, Foundry formatting | Passed. Existing Vite large-main-chunk warning remains. |
| Full native Composer/signer/browser rehearsal | Passed; [source/executable record](native-summary.json), [scenario evidence](native-scenario.json). Real isolated settlement, both allowance configuration batches, owner changes, bidirectional split payments, rule, invoice rollback and independent follower replay. |

The Anvil batch rollback test records successful allowance configuration before
an intentionally failing call. Canonical post-state restores the module flag,
allowance, newly-created alias and Safe nonce; a later valid batch completes all
four operations using the existing 2-of-3 quorum. This is EVM atomicity evidence,
not by itself cross-chain settlement evidence.

The native run at `.runtime/treasury-integration/20261020T204749-57y6wz2v`
used runtime revision `fa916b13254a36423cad130080dde367bb18a7d6`, protocol
`855fe0602484750861b4c31502a1a91355d33ed6`, and verified executable hashes
reused from the recorded earlier build. Its L1 and L2 allowance configuration
batches each contained three calls; alias provisioning was separate in that
fixture. The four-call L1 variant is covered by the Anvil setup test above.
Both posted attestation verification and independent follower replay passed
at L2 height 750. History retained four settled payments, three preparation
rejections and one rollback across reload, with no automatic resubmission.
The invoice trace records two successful L1 transfers before the later failure;
recipient balances, allowance counters, global counter and Safe nonce restore.

After that native run, the planner was refined to leave a lone remaining
configuration call as a direct transaction, avoiding deployment of an unnecessary
batch helper. Previously started version 3 batches retain their plan. Only
`src/lib/treasury/deployment.ts` and its unit test changed after the native source
snapshot, as verified against every recorded source hash. The final 267-test
suite, TypeScript/Vite build and installed-browser check include this refinement.
The full native run was not repeated for that setup-planner-only change; payment
contracts, batch encoding and native test harness bytes are unchanged.

Bulk logs, images and chain state are local-only under
`.runtime/treasury-simplified-setup/` and the run locations in these records.
The small JSON records in this directory are retained with the source.

## Local UI deployment

Only the UI image was updated, using an image-only final Compose overlay at
`.runtime/treasury-simplified-setup/ui.compose.yml`. The complete Compose config
was compared before applying it; only `services.ui.image` differed. Node, signer
and monitor IDs/images/start times are unchanged and runtime `config.json` has
the same SHA-256. The three served application JS bundles exactly match the
locally built bytes. See [deployment evidence](ui-deployment.json).

Refresh the same dashboard origin to load the new code. Keep browser storage;
the migration preserves the first confirmed implementation and resumes with
Safe creation through the official Chiado factory. If another transaction is
already pending, confirmation/recovery finishes that exact request first.

## Failures, limits and remaining rehearsal

A host `/tmp` quota prevented an initial temporary edit script from being written;
source checks confirmed no edits ran. Work then used dashboard-owned paths. The
native runner now places process/Chromium temporary files within its owned run.
An initial TypeScript union-event cast failed compilation and was corrected
before tests or installation. These were implementation/environment failures,
not retry-only passing semantic tests.

The complete 23-transaction shared-network deployment, real wallet-extension
approvals, hosted Safe-app indexing and a shared payment still require the user
rehearsal. The hidden page is visibility control, not authorization. No Guard or
owner-spending restriction was added. Reusable bridge deployments and a factory
that groups contract creation are outside this increment; those remaining
application deployments explain why setup still requires more than four wallet
transactions.

See the [accepted design](../../proposals/one-treasury-two-safes.md) and
[operator procedure](../../runbooks/treasury-shared-network.md).
