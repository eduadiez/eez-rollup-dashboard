# Treasury setup transaction tracking — 2026-10-21

The previous UI polled known hashes but displayed an editable recovery form for
every pending request. Missing or repriced hashes required manual input. Setup
now checks the saved sender/nonce in the latest 512 safe blocks, persists an exact
matching hash, then runs the existing canonical receipt and deployment checks.
Manual recovery is a closed disclosure. No pending request is resent or cleared.

Scope and invariants are in the [accepted proposal](../../proposals/one-treasury-two-safes.md#accepted-setup-tracking-improvement-2026-10-21);
operation and fallback limits are in the [runbook](../../runbooks/treasury-shared-network.md#recovery-and-configuration).
The checkout has pre-existing treasury work; [source hashes](sources.json) identify
the changed source/test files and unchanged browser contract bundle against base
`0d26cf24d2fa23de31021d1a508f137e24804efd` and core
`855fe0602484750861b4c31502a1a91355d33ed6`. The core worktree was clean.

## Validation

- `npm run build` and the Docker production build passed. The first TypeScript
  build rejected a nullable transaction recipient; the type guard was corrected
  before validation. The existing Vite chunk-size warning remains.
- `node --test tests/treasury-deployment.test.mjs tests/treasury-deployment-batches.test.mjs tests/treasury-setup-state.test.mjs`: 44 passed.
- `npm test`: 289 passed, no skipped or ignored tests. New cases cover missing
  responses, fee replacements, request mismatches, canonical/safe confirmation,
  reverts, invalid runtime, reorg cache invalidation, RPC gaps and search bounds.
- `npm run check:treasury-artifacts`: passed; 16 unchanged contract artifacts.
- `node tests/integration/treasury-setup.mjs`: 11 cases passed on two owned
  Anvil 1.7.1 processes using dynamically allocated loopback ports. Real signed
  transactions demonstrated a lost response and an actual fee replacement;
  historical nonce discovery led to exact canonical deployment validation.
  Existing Safe quorum, rollback and configuration checks also passed. Protocol
  discovery/checkpoints are fixture substitutes; this is not EEZ settlement or
  independent follower replay evidence. Both owned processes stopped normally.
  See [Anvil summary](anvil.json).
- `TMPDIR="$PWD/.runtime/treasury-auto-tracking-20261021/tmp" EEZ_UI_URL=http://127.0.0.1:8080/dashboard EEZ_UI_EVIDENCE=.runtime/treasury-auto-tracking-20261021/browser node tests/treasury-shared-browser.mjs`: passed.
  This uses isolated browser storage and rejects signing/submission. Discovery
  uses a controlled read-only RPC response fixture, with real shared-network
  identity reads and no shared-network transactions. Normal pending status,
  collapsed fallback, discovered-hash reload, saved progress and recovery passed.
  See [browser summary](browser.json).
- `git diff --check`: passed.

## Local deployment and limits

Only the local UI service was recreated using the image-only overlay
`.runtime/treasury-auto-tracking-20261021/ui.compose.yml`. Rendered Compose
configuration differed only in the UI image. Runtime configuration checksum and
monitor/node/signer identities were unchanged; served treasury bytes matched the
local production build. See [deployment record](deployment.json).

Bulk logs/screenshots are local-only in `.runtime/treasury-auto-tracking-20261021/`;
Anvil diagnostics are local-only in `.runtime/treasury-flexible-setup/anvil-rwxTEn/`.
Historical state availability and the 512-safe-block search bound can still
require a pasted hash. Discovery cannot accept a different transaction or prove
successful execution by nonce alone. Existing journals need no migration.
No actual browser extension signing, shared-chain broadcast, native cross-chain
E2E, or independent replay was rerun for this application-only change.
