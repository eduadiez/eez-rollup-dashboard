# Settlement-policy monitor deployment — 2026-09-13

The monitor update is deployed at https://eez.asuscomm.com/monitor/.
The existing branding, read-only service model, public gateway and other UI
applications are preserved. Existing uncommitted changes were retained.

The policy panel mirrors the running composer's configuration: `always` for
pure L2 work, a general threshold of 150 L2 blocks, two-second L2 cadence, and
fullness disabled. Progress comes from the applied canonical L1 commitment and
latest L2 height. Five minutes is the nominal general interval; earlier
transaction triggers and actual L1 inclusion still determine posting.

Recent posts now have a separate bounded registry-log window (512 L1 blocks,
12 displayed posts). They remain visible between five-minute settlements.
The public snapshot recorded 12 posts with eleven consecutive 300-second gaps.
Receipt costs include execution and blob fees using exact integer arithmetic;
missing data stays unknown. Beacon availability supports the Fulu full-blob
API and compatible older sidecars. Canonical inclusion is checked for history,
receipts and decoder requests. Separate transactions in one L1 block remain
separate, and duplicate events do not duplicate posts.

## Verification

- 35 Python tests passed, including configuration, missing/stale data, progress
  boundaries, restart reconstruction, reorgs, same-block posts, exact receipt
  costs, full-blob/legacy API handling and invalid decoder inclusion.
- The existing JavaScript harness and added policy/rendering cases passed.
- Standalone Compose validation, image build and `git diff --check` passed.
- Public HTTPS browser checks passed with certificate validation: prefix
  redirect, relative assets and APIs, desktop and mobile layout, history
  search/clear, native decoding and canonical correlation. No JavaScript or
  HTTP errors and no document-level horizontal overflow were observed.
- Live decoding covered an empty 150-block batch, a two-blob batch containing
  198 blocks and six transactions, and a cross-chain semantic transaction.
  The public browser repeated the empty and two-blob cases on the final image.
- The public snapshot was healthy, with L1 commitment matching the L2 safe
  block. Deployed executable/static file hashes match this checkout.

The policy configuration is supplied to the monitor, not discovered through
Ethereum RPC. Keep it in sync when changing composer settings. Chain progress,
posting intervals and costs are live observations. The decoder and Beacon
availability views do not replace cryptographic DA verification or replay.

[Machine-readable results, image identity and source hashes](settlement-policy-verification-2026-09-13.json)
record the deployment. Raw browser captures, logs and API responses are in the
sibling rollup checkout at `artifacts/monitor-policy-20260913/`.

The image is `eez-network-dashboard:settlement-policy-20260913`.
The previous container is retained, stopped and disconnected, as
`eez-monitor-before-settlement-policy-20260913` for rollback. The temporary
candidate is removed after public verification. No devnet node restart was
needed, and the playground at `/` is unchanged.
