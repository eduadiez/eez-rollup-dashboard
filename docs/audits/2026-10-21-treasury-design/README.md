# Treasury design review and simplified restart — 2026-10-21

Implemented in `eez-rollup-dashboard`, branch `feat/treasury-demo`, on dirty
HEAD `0d26cf24d2fa23de31021d1a508f137e24804efd`. Existing work and operator
configuration were preserved. The protocol (`855fe0602484750861b4c31502a1a91355d33ed6`),
Safe (`bf943f80fec5ac647159d26161446ac5d716a294`) and allowance module
(`c95f03900bff99be090dadb9de1c74b162365485`) pins are unchanged. Per-file before/after
digests are in [sources.json](sources.json).

## Changes and review findings

The user removed the archive-collection requirement. **Start new treasury** is
now a compact secondary action returning to **Choose your Safes**, with the
connected wallet retained. Each chain offers new or existing Safe addresses.
Restart neither prepares deployments nor requests signatures or transactions.
No new archives are created or displayed; stored records from older builds are
left untouched. Before deployment starts, **Change setup** serves the same
purpose without a second restart control.

The review used [DESIGN.md](../../../DESIGN.md), including its dashboard-specific
rules that take precedence over the smaller quickstart text sizes. Corrected
11px badges and owner addresses to 12px and 13px, and table text to 13px.
Environment labels are neutral; observed connection and owner approvals may
use green. Named chain labels use the established L1/L2 accents. Approval and
submission buttons emphasize the current stage. Supported-Safe and supporting
deployment detail is expandable. Submitted transaction hashes and rollback
posts link to the existing execution inspector using their source chain.

Restart selects the chooser with one empty-journal write. Storage failure leaves
the previous setup active. The empty journal suppresses stale manifests and
legacy fallback; a new reviewed plan uses its own salt. Selection and live wallet
actions retain the existing Web Lock. Current pending setup, payment and owner
requests block restart. An updated journal for the same selected treasury does
not falsely count as another treasury. See the
[operating procedure](../../runbooks/treasury-shared-network.md#start-a-new-treasury-with-the-same-wallet).

## Validation and limits

- `npm test`: **282 passed, zero failed/skipped**, including ten setup-state
  checks for pending requests, late requests, selection changes, storage failure,
  old records and lock exclusion.
- `npm run build`: TypeScript and Vite passed; the existing bundle-size warning
  remains. Runner Python syntax, source inventory and edited-file whitespace
  checks passed. `git diff --check` passed.
- The original browser suite passed against the prior installed build, which
  still showed the archive collection. The updated suite passed against the
  final installed build: same wallet, fresh salt after review, existing-Safe
  choices, partial/completed restart, reload, storage failure, pending setup /
  payment / owner blocking, two-tab exclusion and selection updates, hidden
  navigation, invalid imports and zero-gas submission blocking.
- Browser design assertions checked 12px neutral badges, named chain colors,
  focus transferred to the setup heading, the green keyboard focus ring and
  reduced-motion behavior. Desktop and 390px screenshots were inspected; the
  mobile document width is 390px. [Browser evidence](browser.json).

The browser uses real read-only shared-network checks with an injected provider,
public fixture addresses and synthetic setup journals/manifests. It blocks all
signature and submission requests. It does not establish real-extension wallet
behavior, a successful existing-Safe import, deployed fixture contracts or new
payment/settlement semantics. Contracts, Composer and protocol code are unchanged;
Solidity and native payment/independent replay suites were not rerun for this
browser-state/design change. Inspector link targets were checked in source;
no new settled payment was created for this review.

Retained failures and corrections are listed in [checks.json](checks.json).
The first browser run exposed a reconnect race in the test. Two subsequent runs
identified the false stale-selection error during background progress refresh.
A focused regression failed before the fix and the same test passed after it.
The final full browser run passed after these corrections; no retry-only pass
was substituted for the failures. Local logs/screenshots remain under
`.runtime/treasury-design-20261021/` (not available in another checkout); their
log digests and small sanitized results are retained here.

## Local deployment

The installed UI image is
`sha256:e2d723c09893a03f67695c3b481e37174461c7aae8a20c1a4dd15df411dfddec`, selected
by the image-only overlay `.runtime/treasury-design-20261021/ui.compose.yml`
appended to the existing operator Compose files. Compose configuration was
compared before each UI replacement; only `services.ui.image` changed.
Node, signer and monitor container identities/images/start times and the served
runtime configuration remained unchanged. Four served JS/CSS assets match the
local production build byte for byte. [Deployment evidence](deployment.json).
The dashboard remains at `http://127.0.0.1:8080/dashboard/`.
