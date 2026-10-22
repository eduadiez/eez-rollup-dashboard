# Treasury inclusion and transaction history — 2026-10-21

Setup now advances on successful canonical inclusion, without waiting for the
safe checkpoint. Exact request, Safe execution, deployment and contract checks
remain in force. Later setup actions recheck earlier inclusions. Transaction
History follows the Bridge & Calls layout and lists setup transactions oldest
first, with per-chain explorer links, observed inclusion/finality and failures.
The two redundant restart paragraphs were removed; pending-request protection
remains.

The [accepted proposal](../../proposals/one-treasury-two-safes.md#accepted-inclusion-based-setup-and-transaction-history-2026-10-21)
and [runbook](../../runbooks/treasury-shared-network.md#recovery-and-configuration)
record scope, compatibility and revalidation limits. [Source hashes](sources.json)
identify this work on the existing dirty dashboard checkout at
`0d26cf24d2fa23de31021d1a508f137e24804efd`; the core pin and clean checkout were
`855fe0602484750861b4c31502a1a91355d33ed6`. No protocol or contract source changed
in this increment.

## Validation

- Before the fix, the targeted `included setup transactions advance before the
  safe checkpoint` regression failed: the successful receipt did not complete
  the step. The same regression passes afterward on both chains.
- `npm test`: 317 passed; none skipped or ignored. New checks cover canonical
  inclusion before safe, a reorg during receipt validation or discovery, moved
  prior inclusions, RPC failures, legacy journals and bounded concurrent reads.
  An intermediate run retained failures from the old safe-head expectations;
  those fixtures were updated to the new contract before the final run.
- `npm run build` and the Docker production build passed. The existing Vite
  chunk-size warning remains.
- `node tests/integration/treasury-deployment-batches.mjs`: 14 cases passed on
  one owned Anvil 1.7.1 EVM using real contracts and read-through EEZ manager
  fixtures. Both wallet-funded setups completed with all 14 new transactions
  ahead of the safe checkpoint. Safe reviews, funding and final configuration
  checks succeeded; both payment directions and independent treasury balances
  were asserted. Logical chain IDs switch per phase. This is contract integration,
  not Composer/proof execution or independent follower replay.
- `node --check tests/treasury-shared-browser.mjs` passed after correcting a
  duplicate test variable. The full read-only browser regression passed against
  the deployed UI, using an isolated profile with signing/submission blocked.
  It checked history order, inclusion/finality/failure and unavailable states,
  both explorer destinations, reload preservation, mobile width, removed text,
  and existing restart/cross-tab safeguards. History states and hash discovery
  use controlled RPC fixtures; shared network identity reads remain live.
  Desktop/mobile screenshots were inspected.
- `git diff --check` passed. [Validation summary](validation.json) records the
  selected cases and browser results.

## Deployment and limits

Only the local UI container was recreated. The Compose difference was solely the
UI image; served HTML, entry assets and the treasury chunk matched the production
build. Runtime configuration checksum and monitor/node/signer container identities
were unchanged. See the [deployment record](deployment.json).

New journal inclusion metadata is optional; old journals remain readable. A
missing or moved prior inclusion stops the next action without deleting progress
or resending. Inclusion remains provisional; finality is displayed separately.
Payment outcome verification was not weakened. Actual extension signing, shared
chain broadcasts, native EEZ E2E and independent replay were not rerun for this
application-only change.

Logs, baseline source snapshots and screenshots are local-only under
`.runtime/treasury-inclusion-history-20261021/`; the owned Anvil run is under
`.runtime/treasury-deployment-batches/anvil-dwY480/`. The sanitized summaries here
remain available to another checkout; local-only artifacts are not committed.
