# Shared treasury infrastructure — 2026-10-21

Status: implemented, isolated semantic validation passed, and local UI updated.

The user authorized sharing one Test USDC asset and an extended bridge pair,
keeping both payment directions and the current setup, and updating the local
dashboard only. All implementation and evidence live in eez-rollup-dashboard.

## Source and deployment baseline

Dashboard base: `0d26cf24d2fa23de31021d1a508f137e24804efd`, existing
`feat/treasury-demo` worktree with prior uncommitted application work. Core:
`855fe0602484750861b4c31502a1a91355d33ed6`; Safe:
`bf943f80fec5ac647159d26161446ac5d716a294`; modules:
`c95f03900bff99be090dadb9de1c74b162365485`. The native harness uses runtime
`fa916b13254a36423cad130080dde367bb18a7d6` plus its recorded local changes.

Before editing, saved setup-related source hashes, existing UI/monitor/node/signer
container identities and the runtime configuration digest under local-only
`.runtime/treasury-shared-infrastructure-20261021/before.json`. All 16 existing
contract deployment/runtime bytecodes remain byte-for-byte unchanged.

## Implementation and invariants

- `SharedTestUSDC` issues 450 six-decimal test units once per setup executor.
  It has no Circle relationship, scarcity claim or Sybil-resistant faucet limit.
- `SharedTreasuryBridge` retains the established payment implementation and
  disables peer administration after configuration. The token publishes a
  once-only bridge registration after local pairing is sealed.
- New setup discovers the earliest compatible canonical registration and verifies
  both bridge runtimes, managers, rollups, peers, asset mapping, and wrapped mint
  authority. Discovery errors cannot authorize duplicate deployment.
- Version 5 retains the prior journal and confirmed identity/history. Outstanding
  requests, collected reviews and existing private token/bridge bindings keep
  their original plan. Older clients reject version 5; versions 2–4 remain readable.
- Reused Safe funding is additive. Distinct Safe pairs retain independent
  balances and policy budgets; reusing the same Safe retains its existing
  balances and spending permissions. Shared escrow backs aggregate wrapped supply.

See the [accepted proposal](../../proposals/one-treasury-two-safes.md) and
[runbook](../../runbooks/treasury-shared-network.md).

## Validation and limits

Focused state/discovery tests and the full JavaScript suite passed before final
UI refinements. Solidity: 63 tests passed, zero skipped. The original format
check flagged the new constructor layout; `forge fmt` corrected it and the
subsequent check passed. Production builds pass with the existing chunk-size
warning. A scripted edit assertion stopped before applying its UI refinement;
that was an edit-time failure, not a passing runtime check.

The real-contract Anvil scenario creates two independent treasuries from different
wallets and reuses the token/bridge addresses. It exercises 110-token split
payments to each destination, independent budgets, rejection invariants and
aggregate escrow backing. Protocol calls use read-through manager fixtures in
this test; they are not Composer/signer validation.

The separate native browser rehearsal passed in 442.67 seconds: one selected
native test, zero failures/ignored/filtered. Actual Composer, signer and independent
follower processes exercised both destinations, the percentage rule, invoice
settlement rollback and preparation rejection. Canonical posting attestation and
independent replay passed. The recorded runtime source inventory and executable
hashes matched the previous successful build before reuse. No shared-network
transactions or operator keys were used.

Final setup-only refinements then added a pre-submission reuse refresh, preserved
direct version-2-to-5 migration backups, and filtered registrations for other
rollups. These do not alter the payment contracts/native payment path. The final
JavaScript suite passed **300 tests**, zero skipped; the real-contract Anvil
scenario passed **11 recorded cases** again with the final setup code. The final
production build, artifact check, Solidity formatting, edited-script syntax and
`git diff --check` passed. No protocol-wide suite was run: the protocol is unchanged.

The local UI image is `eez-rollup-ui:treasury-shared-infrastructure-20261021`,
container image identity recorded in [deployment.json](deployment.json). An
image-only Compose overlay retained all existing operator files. The served
`TreasuryDemo-CNe0K58q.js` matches the host build byte-for-byte; runtime configuration
SHA-256 remains `d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.
Monitor, node and signer container IDs/start times are unchanged.

Read-only browser checks passed on the actual local deployment with separate
browser storage: selected wallet, version-5 migration, confirmed/pending legacy
recovery, restart, reload, cross-tab locks and mobile width 390/390. Shared reuse
uses explicitly mocked read-only contract responses in that browser test; actual
reuse is independently covered by Anvil. No browser signing/submission occurred.
The first mobile screenshot was captured before wallet reconnection and scroll
reset; the fixture now waits for those, and the final desktop/mobile screenshots
were inspected. The final read-only browser rerun passed.

The first shared infrastructure installation requires connected-wallet approvals.
Finish that installation before starting another initial one; concurrent global
installation is not coordinated by a singleton factory. Existing private-asset
treasuries are intentionally not migrated. Live Chiado treasury payments and
external wallet-extension prompts remain outside this isolated validation.

Bulk logs and screenshots under `.runtime/` are local-only and unavailable to a
fresh checkout. Small sanitized summaries are retained alongside this record.
