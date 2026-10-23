# Treasury payment allocation slider — 2026-10-21

Status: implemented and deployed to the local dashboard. Contract, client, browser
and isolated native validation passed. Public treasury activation remains a wallet action.

## Scope and identity

Dashboard checkout `feat/treasury-demo`, base HEAD
`0d26cf24d2fa23de31021d1a508f137e24804efd`, with the existing uncommitted treasury
work preserved. EEZ core `855fe0602484750861b4c31502a1a91355d33ed6`, Safe
`bf943f80fec5ac647159d26161446ac5d716a294`, allowance modules
`c95f03900bff99be090dadb9de1c74b162365485`. Native runtime source remains
`fa916b13254a36423cad130080dde367bb18a7d6`; source and executable hashes are
verified by the existing isolated runner. No protocol source or pin changed.
Foundry 1.7.1, Solidity 0.8.34 / legacy 0.7.6, Node v26.7.0.

The old policy artifacts have no `paySplit` selector and can only choose local
or destination-first funding. This is the baseline capability gap: a UI-only
percentage control cannot enforce arbitrary contributions. The new contract
shares the existing authorization/accounting/bridge path, signs an exact L1
contribution, and charges the remainder to L2. Both limits still apply.

The [accepted increment](../../proposals/one-treasury-two-safes.md#accepted-payment-allocation-slider-2026-10-21)
and [handover runbook](../../runbooks/treasury-shared-network.md#enable-custom-splits-on-an-existing-treasury)
cover scope and compatibility. Existing pending requests and setup bytecode are
preserved. Setup version 9 and handover version 2 use distinct new artifacts.
A second handover includes the previous policy's inherited counters; history
retains both predecessors. Rules/invoice scenarios keep automatic allocation.

## Validation

- `forge test --root contracts`: 186 passed, none failed/skipped. Real Safe and
  allowance/token contracts use test cross-chain proxies. Includes fuzzed exact
  splits from both entry paths to both destinations, single-base-unit amounts,
  signature mutation, capacity/global rejections, earlier-leg rollback, and
  inherited spending through two handovers. This is not native proof coverage.
- `npm test`: 364 passed, none failed/skipped. Exact calldata, recovery hashes,
  settlement contributions, old/new setup artifacts, inherited history and
  capacity checks are covered.
- `EEZ_UI_EVIDENCE=.runtime/treasury-split-20261021/browser-final node tests/treasury-wallet-browser.mjs`:
  passed. Controlled RPC/wallet browser coverage includes percentages/amounts,
  exact 100+10 default allocation, frozen review, keyboard endpoints, changed
  capacity without rebalancing, mobile overflow and six-decimal reload recovery.
  Existing wallet-network and owner-refresh checks also pass.
- `TREASURY_UPGRADE_VERSION=1 node tests/treasury-upgrade-browser.mjs` and version
  `2`: passed. Controlled browser tests cover the resumed legacy journal and the
  custom-split flow, three simulated transactions, two Safe signatures, lost
  wallet response recovery without resend, and desktop/mobile layout.
- Production frontend build, generated browser artifact check, Foundry formatting,
  Python syntax and `git diff --check`: passed. Existing bundle-size warning remains.

The first native scenario at `.runtime/treasury-integration/20261021T195833-c12zz8jm`
completed its actual owner, handover, payment and follower assertions. The runner
then **failed** its final source-inventory guard because application files were
still being edited during execution. That run is not recorded as verified. The
final rerun freezes application sources and retains the first run's diagnostics.
Initial client/browser test failures and their corrections remain in the local
`node-tests.log` and `browser.log`; final results are separate files.

## Evidence and limits

Local-only evidence: `.runtime/treasury-split-20261021/` contains check logs,
screenshots, the deployment record and a hash inventory. Native runs retain their
own `summary.json`, `scenario.json`, logs/datadirs and executable identities under
`.runtime/treasury-integration/`. These ignored paths are not available in another
checkout. No keys, runtime configuration contents, bulk logs or databases are
included in this record.

Public Chiado activation requires the connected wallet's policy deployment and
both Safes' owner approvals. This task does not sign or broadcast those changes,
move treasury funds or replace the user's Safes. A human wallet-extension/Safe-app
rehearsal remains separate from automated isolated proof and browser validation.

## Final native validation and local deployment

`python3 scripts/run-treasury-integration.py --runtime /path/to/rollupX
--reuse-run .runtime/treasury-integration/20261021T170134-zaqf3_0g` completed
successfully with unchanged source inventories. Evidence:
`.runtime/treasury-integration/20261021T200329-givcr3d3/summary.json`,
`verified: true`; one intended native process scenario passed, no ignored tests.
The exact-allocation matrix was:

| Initiating Safe | Recipient chain | Total | From L1 | From L2 |
| --- | --- | ---: | ---: | ---: |
| L1 | L2 | 70 | 35 | 35 |
| L1 | L1 | 10 | 0 | 10 |
| L2 | L1 | 10 | 10 | 0 |
| L2 | L2 | 20 | 5 | 15 |

This follows the preserved 40-USDC L2 payment before the policy handover and ends
at 150 globally. Each payment settled canonically and was independently replayed;
actual Safe and recipient balances matched the signed amounts. Global exhaustion,
replayed signatures and a forged initiating caller were rejected. Native rollback
of the new exact-split entry point was not separately exercised; its later-leg
rollback is covered by the real-Safe Solidity fixture with test proxies.

Local image: `eez-rollup-ui:treasury-split-20261021`. Only the existing UI service
was replaced. Compose comparison allowed only its image to change. Health and
served treasury assets match the tested build. Monitor, node and signer IDs/images
are unchanged. Runtime config SHA256 remains
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.
Browser storage and public Safe configuration were not modified.


## Follow-up: fresh-deployment UI (2026-10-21)

The user subsequently chose to assume new treasury deployments. The dashboard
now always presents the fixed-payment split slider, with no activation link,
policy-upgrade card, signing or deployment workflow. The retired handover client
moved to `tests/fixtures/treasury-policy-upgrade.ts`; application code only reads
its historical journal rows. Saved requests, old deployment bytecode, history
and pending-request guards are retained. A legacy policy is not marked capable
of `paySplit`. Fresh version-9 setup already deploys the required policy.

Validation for this follow-up:

- `npm test`: 365 passed, zero failures or skips, including exact signing,
  fresh-setup artifact selection and retained handover history validation.
- `npm run build`: passed, with the existing large-chunk warning.
- `node tests/treasury-wallet-browser.mjs`: passed with mocked RPC/wallet,
  including immediate slider availability, both initiating chains, exact signed
  contributions, locked review, capacity changes and keyboard/mobile use.
- `node tests/treasury-owners-browser.mjs`: passed with mocked RPC/wallet.
- Integration runner Python syntax and its 118 application inventory path
  references checked. Its retired plan import now resolves to the test fixture.
- No Solidity or protocol changes; Foundry/native process suites were not rerun
  for this UI removal. Earlier process evidence above validates the earlier
  source inventory, not this follow-up. No public wallet transactions were sent.

Local evidence, including before-edit copies, source hashes, logs, screenshots
and the deployment record: `.runtime/treasury-new-deployments-20261021/` (ignored
and local only). The first ad-hoc inventory scanner included external runtime
paths; restricting it to the actual application inventory corrected that check
without changing application behavior.

UI image: `eez-rollup-ui:treasury-new-deployments-20261021`. Health, byte equality
between the served treasury assets and the tested build, unchanged runtime
configuration, and unchanged monitor/node/signer container identities verified.
