# Treasury restart and archive — 2026-10-21

The user authorized a **Start new treasury** button that archives the current
setup, keeps the connected wallet and starts a fresh deployment, plus updating
the local dashboard. All changes are in `eez-rollup-dashboard`, branch
`feat/treasury-demo`, on existing dirty HEAD
`0d26cf24d2fa23de31021d1a508f137e24804efd`. No shared-chain transactions were
submitted and the user's actual browser records were not read or reset.

The control is available during setup and on a completed, browser-managed shared
treasury. It prepares a new plan with the connected wallet, new salt and new
Safes. Archives include raw journal/manifest records, confirmed hashes and
available payment history; the UI lists them and downloads JSON. Existing
contracts, assets and allowance authority remain on-chain. This does not restore
or revoke previously deployed contracts.

The archive write precedes the single active-journal replacement. Either write
may fail without deleting the original active journal, manifest or history.
The selected journal binds a manifest by salt and Safe addresses. An empty
journal intentionally masks legacy fallback after Change setup. Prior manifests
remain stored for recovery; older UI builds lack selection binding and can reopen
one, so keep this build or later after a restart. No automatic archive-import UI
was added. See the [procedure and storage contract](../../runbooks/treasury-shared-network.md#start-a-new-treasury-with-the-same-wallet).

Pending setup requests, live submissions and owner changes block restart.
After verified completion, New payment/New action or Done releases the saved
live request. Restart and live wallet actions share the existing setup Web Lock.
An old tab checks the selected instance inside that lock before signing/sending;
setup writes also reject a changed salt. Other tabs observe selection changes.

## Validation

- `npm test`: **281 passed, zero failed/skipped**, including nine archive tests.
  Covers exact record preservation, same-wallet fresh state, legacy masking,
  pending requests with/without hashes, payment/owner requests, stale writers,
  both storage-write failures, retry without duplicate archives, invalid records,
  and live-action lock/selection checks.
- `npm run build`: passed (TypeScript and Vite); existing chunk-size warnings.
- `tests/treasury-shared-browser.mjs`: passed against the installed UI. Real
  read-only network validation and injected public-address wallet provider;
  synthetic setup journals and completed manifest. No signing, broadcast, actual
  extension use or claim of deployed fixture application contracts. Covers
  restart from both views, same wallet/new salt, archive download bytes, reload,
  archive-storage failure, two-tab exclusion and selection updates, pending
  setup/payment/owner blocking, hidden navigation, existing-Safe controls and
  390px layout. See [browser evidence](browser.json).
- `git diff --check`, edited-document links and Python runner syntax: passed.
  Contract artifacts/protocol/runtime were unchanged. Solidity and native
  Composer/payment suites were not rerun for this browser-state change; the
  native runner's source inventory now includes the new archive/UI files.

Retained development failures: the first build found an overly narrow `Hex`
parameter on the instance guard; it was aligned with the existing validated
`TreasuryConfig.instance` string type. Three initial browser attempts found test
fixture problems: a download-buffer variable shadowed the lazy-chunk list; the
fixture parsed the new intentional empty journal as JSON; and a new tab had not
used the hidden-demo shortcut. Each fixture was corrected before the same check
passed. These are corrected failures, not discarded retry-only passes.

## Installed UI

Only `services.ui.image` changed through the image overlay
`.runtime/treasury-restart-20261021/ui.compose.yml`. Node, signer and monitor
container IDs/images/start times and the served runtime configuration stayed
unchanged. Three served JS bundles match the built bytes. See [deployment
identity](deployment.json) and [source hashes](sources.json).

The source protocol/Safe/allowance pins remain
`855fe0602484750861b4c31502a1a91355d33ed6`,
`bf943f80fec5ac647159d26161446ac5d716a294`, and
`c95f03900bff99be090dadb9de1c74b162365485`. No dependency updates, wallet
credentials or operator settings were changed. Logs and screenshots are local-only
under `.runtime/treasury-restart-20261021/`; the small JSON records here are portable.
