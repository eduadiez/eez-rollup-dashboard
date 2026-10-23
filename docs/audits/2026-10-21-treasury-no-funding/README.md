# Treasury setup without funding

New setup contains no token approval, transfer, bridge deposit, token balance
requirement, faucet entry or skip control. Its five ordinary transactions connect
the existing Chiado Safe and EEZ-X mirror, register live owner verification and
configure the 100-per-Safe / 150-shared limits. Additional existing-Safe adoption
or occupied wallet-address preparation remains conditional.

The [accepted change](../../proposals/one-treasury-two-safes.md#accepted-setup-without-funding-2026-10-21)
and [runbook](../../runbooks/treasury-shared-network.md#shared-asset-lifecycle-and-compatibility)
describe the version-8 migration. It preserves confirmed work and any completed
approval. Pending calldata and signed reviews remain unchanged until resolved.
Version-7 skipped-funding and completed legacy funding plans remain readable.
The required owner-verification call closes the original executor; no token
transfer replaces the removed funding actions.

## Identity and checks

Dashboard base: `0d26cf24d2fa23de31021d1a508f137e24804efd`, branch
`feat/treasury-demo`, with existing uncommitted treasury work retained. Pinned core:
`855fe0602484750861b4c31502a1a91355d33ed6`. No Solidity, core or runtime source was
changed. Anvil 1.7.1 (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`) ran the contract
fixture. Source and executable hashes are in the local validation record below.

- `npm test`: 348 passed; zero failures/skips. Includes migration from fresh,
  unsubmitted and already-approved plans; pending/review preservation; immutable
  progress and downgrade rejection; and connection preparation with no token reads.
- `node tests/integration/treasury-deployment-batches.mjs`: 17 cases, 53 transactions,
  verified. Real contracts complete setup with an empty wallet and empty Safes,
  close both executors, establish allowances and accept manifest verification.
  Later ordinary transfers allow payments on both chains. Legacy funded setups,
  split payments and budget rejection also pass.
- `npm run build` and `npm run check:treasury-artifacts`: pass; 20 unchanged
  contract artifacts. The existing Vite bundle-size advisory remains.
- Focused served-browser check: all five steps have no funding controls;
  automatic migration preserves confirmed transactions and approvals; reload and
  pending-request preservation pass at 1440px and 390px. Screenshots were inspected.
  This uses read-only controlled RPC responses and separate browser storage.
- `node --check tests/treasury-shared-browser.mjs` and `git diff --check`: pass.

The contract fixture uses one owned Anvil with read-through cross-chain managers;
its network-identity and fee-quote fixtures do not prove native Composer/proof
settlement. Client manifest identity validation is replaced only for this
single-EVM fixture; owner, code, balance and allowance reads use real contracts.
No public-network wallet submission or full native E2E run was performed.

The broader browser smoke failed in its existing history-route transition with
`route.fulfill: Route is already handled!`. Its failure log is retained; this is
not counted as a passing full smoke or retried into a pass. The focused setup
check avoids those unrelated routing changes and drains handlers on shutdown.
The first build of the automatic migration also caught an obsolete UI variable
name; it was corrected before the passing build and deployment.

## Local deployment and evidence

Only the dashboard UI was replaced with `eez-rollup-ui:treasury-no-funding-20261021`:
`sha256:3fcd50635174023f7708b5a3349f7ed072db6ac7a4091b532e5c1ce768059537`. The monitor, node and signer container identities and runtime
configuration hash were verified unchanged. Health returns 200; served treasury
JavaScript/CSS are byte-identical to the build. The user's browser storage was
not edited by the test; its eligible saved setup migrates when the updated UI
loads and polls. No Safe was deployed or funded on the shared networks.

Local-only evidence, unavailable in another checkout:

- `.runtime/treasury-no-funding-20261021/validation.json` and `deployment.json`:
  source/executable hashes, service identities, configuration and served hashes.
- `.runtime/treasury-no-funding-tests.log`: unit results.
- `.runtime/treasury-deployment-batches/anvil-k2nAk8/`: contract receipts and summary.
- `.runtime/treasury-no-funding-20261021/focused/`: browser result and screenshots;
  `browser.log` in its parent retains the broader smoke failure.
- `.runtime/treasury-optional-funding-20261021/after/`: prior deployed behavior
  still showing the optional 450-token funding form, before its full removal.
