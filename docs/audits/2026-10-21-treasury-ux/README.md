# Treasury UX cleanup — 2026-10-21

Implemented in `eez-rollup-dashboard`, branch `feat/treasury-demo`, on dirty
HEAD `0d26cf24d2fa23de31021d1a508f137e24804efd`. Existing treasury work and
operator configuration were preserved. The protocol pin is
`855fe0602484750861b4c31502a1a91355d33ed6`, Safe is
`bf943f80fec5ac647159d26161446ac5d716a294`, and Safe modules is
`c95f03900bff99be090dadb9de1c74b162365485`; none changed. See
[sources.json](sources.json) for per-file identities. A null before digest means
that file was not in the initial local copy; it does not mean the file was new.

## Review and changes

The review used [DESIGN.md](../../../DESIGN.md). The main problems were repeated
setup metadata ahead of the next action, permanent infrastructure addresses,
network/authorization cards ahead of payments, and technical details competing
with the signing decision.

- Removed the standalone deployment-wallet and reused-infrastructure panels.
  Ownership consequences now sit beside new/existing Safe choices and the
  creation/adoption step. Funding amounts and test-token context appear when
  funding; 100-per-Safe and 150-shared limits appear during configuration.
- Setup leads with compact progress, the current action and its chain. The
  current call list and full setup record are expandable. Imported-Safe owner
  changes and pending-request recovery remain visible before approval.
- The connected view starts with the shared budget and each Safe balance, then
  payment review and owner approvals. The funding split, recipient, destination
  and rule authorization remain visible before signing. Token movement and
  technical identifiers are expandable.
- Rehearsal shortcuts are under **Demo scenarios**. **Add an owner** and
  **Treasury details** are disclosures. Pending owner changes reopen their
  disclosure; history keeps outcome badges and expandable verified evidence.
  Empty history omits its filter and refresh control.
- Navigation uses **Payments**, **Owner demo**, and **Simulation**, with matching
  accessible names. The optional owner demo appears only with its deployed
  action fixture; fresh shared treasuries omit that fixture. Owner administration
  stays in **Add an owner**. Geist amounts, named chain accents, neutral environment
  labels, green observed network readiness, shared focus styles and responsive
  layouts follow the dashboard design guidance.

This is a presentation change. Contract calls, approvals, transaction binding,
funding limits, deployment grouping and browser-storage formats are unchanged.
The same-wallet restart and pending-request exclusion from the
[earlier design increment](../2026-10-21-treasury-design/README.md) remain in use.

## Validation

- `npm test`: **282 passed**, zero failures or skips.
- `npm run build`: TypeScript and Vite passed. The existing bundle-size warning
  remains. `git diff --check` passed.
- `tests/treasury-shared-browser.mjs`: passed against both a separate UI preview
  and the installed dashboard. Real shared-network reads; injected read-only
  wallet; every send/sign request blocked. Synthetic journals exercise the
  creation, funding, budget and Safe-configuration presentation. Checks retain
  confirmed progress, pending requests, reload, same-wallet restart, storage
  failure and cross-tab locking. Focus, minimum badge size, chain accents,
  reduced motion and mobile overflow assertions also pass.
  [Sanitized browser result](browser.json).
- `tests/treasury-demo.cjs`: passed against the installed build with mocked RPCs,
  covering simulation isolation, both directions, exact budget sequence, hidden
  navigation, storage denial and four viewport widths. [Result](simulation.json).
- Desktop, 390px and 320px payment layouts were inspected against real isolated
  devnet balances and owners. Neutral environment and positive readiness colors,
  and matching visible/accessibility navigation names, were checked in the DOM.
  A read-only browser checks both the optional owner-fixture tab and its absence
  when the manifest has no action fixture. [Visual checks](visual-checks.json).
  Setup/funding/budget screenshots were inspected at
  desktop and 390px. The separate visual browser did not connect a signing wallet.

The frozen-source native run `20261021T084140-gsj55c8g` passed: **one native
process test, zero failed/ignored**, `scenarioComplete: true`, and runner
`verified: true`. It checked all 78 application source hashes before and after,
plus the native runtime inventory. [Sanitized native evidence](native.json).
The command was:

```bash
npm run test:treasury:ui -- --runtime /home/edu/Development/rollupX \
  --reuse-run .runtime/treasury-integration/20261020T214323-i3_i1id1
```

It used verified recorded binaries from runtime
`fa916b13254a36423cad130080dde367bb18a7d6`, the protocol pin above, real
contracts, a Composer, proof signer and independent follower. Assertions covered
owner changes/signatures, reload/lost-response recovery, invoice rollback after
both transfers, preparation rejection, 40 local / 110 split / independent global
rejection, 10% of combined holdings, split funding to EEZ-X, natural budget resets,
and history filtering/reconciliation/unavailable-read recovery. The history ended
with four settled payments, three preparation rejections, one verified rollback
and zero automatic resubmissions. Independent replay and the posted attestation
were verified. The wallet is a test EIP-1193 provider with genuine public-fixture
signatures, not a browser extension. Human wallet/Safe-app rehearsal and shared
network payments were not performed for this UX update. Full Solidity/protocol
regression suites were not rerun; contract sources were unchanged.

The first native run (`20261021T082015-dbj5zieb`) stopped at an old
**Connected owner demo** selector after tab labels changed during that run.
Its failed screenshot, log and datadir remain local. The second
(`20261021T082357-pr5d0c_e`) passed all browser/chain assertions, but the runner
correctly rejected application-source changes made while it was running. That
run remains `verified: false`. After freezing the final UI and selectors, the
third run passed both execution and source-stability checks. Neither earlier
attempt is substituted for certified final-source coverage; validation was not
bypassed. The optional missing-fixture tab was identified by source inspection;
its final present/absent browser checks pass, without a before-fix browser run.

## Local deployment

The installed image is
`sha256:649809db7cad5be5edb7b29d4e899541e4b0a48f71cde09e404668848d852079`, selected
by `.runtime/treasury-ux-20261021/ui.compose.yml`, appended after all pre-existing
Compose files. UI replacements compared the rendered configuration before
and after: only `services.ui.image` changed. Only the UI service was recreated.
The monitor, Chiado node and proof signer retain their IDs, image digests and
start times. The runtime configuration hash remains
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.

[Deployment hashes](deployment.json) record the final image, served assets and
local validation logs. The served treasury JavaScript, treasury CSS, main JavaScript and contract
artifact bundle match the final local build byte-for-byte. The UI health check
passes. No shared-network transaction was signed or broadcast by this work.
The user's connected browser and its deployment journal were not accessed.

Local logs and screenshots are under `.runtime/treasury-ux-20261021/` and the
native run directories. They are ignored and unavailable in another checkout;
small sanitized records and hashes accompany this audit. Use the
[shared-network runbook](../../runbooks/treasury-shared-network.md) for the current
UI selection and rehearsal controls.
