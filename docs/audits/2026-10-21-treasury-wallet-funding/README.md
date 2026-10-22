# Shared infrastructure predeployment and standard wallet funding

Date: 2026-10-21. Implements the user's request to predeploy the shared Test USDC
and bridge pair separately, use ordinary ERC-20 funding in treasury setup,
preserve confirmed setup progress, and update only the local dashboard UI.

## Identity and scope

- Dashboard branch `feat/treasury-demo`, base
  `0d26cf24d2fa23de31021d1a508f137e24804efd`, with substantial pre-existing work.
  [Application source hashes](source-hashes.json) identify this increment.
- Runtime base `fa916b13254a36423cad130080dde367bb18a7d6`, existing local changes
  retained. No runtime source, configuration, protocol or chain data edited.
- Local core gitlink `855fe0602484750861b4c31502a1a91355d33ed6`; Safe
  `bf943f80fec5ac647159d26161446ac5d716a294`; modules
  `c95f03900bff99be090dadb9de1c74b162365485`.
- Live network identity is checked against the dashboard's pinned shared-network
  profile. The older local core build is not substituted for deployed bytecode.
- Contract artifacts are unchanged: 18 contracts, 632858-byte browser bundle.
  Pending legacy calldata continues to use the same bytecode.

## Resulting behavior

One operator deployment creates and seals the shared infrastructure in three
transactions. A one-unit bridge deposit initializes its backed wrapped asset.
No user Safe is created or funded by this procedure. The CLI uses the existing
transaction preparation/confirmation engine, saves the exact hash before sending,
and retains uncertain requests in a separate local journal.

Version-6 treasury setup binds to that existing infrastructure. The connected
wallet approves 450 tokens, then the funding batch debits it with `transferFrom`,
transfers 300 to its Chiado Safe and bridges 150 to its EEZ-X Safe. The allowance
and executor balance are checked after confirmation. No setup step invokes a
faucet or mint. A separate explicit test-only faucet screen owns its own request
journal. The shared budget remains 150 and each Safe allowance remains 100.

Eligible early setups keep wallet, salt, addresses and confirmations when adopting
the new plan. Pending/reviewed or already funded legacy setups retain their
original plan. Existing manifests and payment routes are unchanged. Older UIs
must not resume a version-6 journal. See the
[runbook](../../runbooks/treasury-shared-network.md) for operations and recovery.

## Validation

- `npm test`: 307 passed, zero skipped/failed. Includes seven new funding and
  migration cases, fail-closed missing infrastructure, insufficient balance and
  approval, and standard ERC-20 verification independent of faucet interfaces.
- `npm run build`: passed; existing large-chunk warning remains.
- `npm run check:treasury-artifacts`: passed; no artifact regeneration required.
- `node tests/integration/treasury-deployment-batches.mjs`: 13 cases passed.
  Real Anvil contracts exercised operator predeployment, two wallet-funded
  treasuries, consumed approvals, unchanged token supply and both payment routes.
  Its read-through cross-chain fixtures do not establish native settlement.
- Initial native browser run `20261021T104030-sdz8367k`: failed at the expected
  wallet-rejection alert. Retained screenshot shows `Failed to fetch`; browser
  diagnostics contain five `net::ERR_NETWORK_CHANGED` L2 requests. Standard
  wallet funding had already passed its debit/supply/allowance assertions.
  Preserve this failure; a later pass is a diagnostic retry, not a clean first run.

- Second native run `20261021T104631-4jhi7la8`: failed before dashboard
  navigation loaded; Chromium reported `ERR_NETWORK_CHANGED` for module imports.
- Third diagnostic run `20261021T105116-s4piwsme`: real owner-approved actions
  settled, but failed loopback reads prevented starting the invoice scenario.
  This happened without concurrent task shell/container operations, so those
  operations alone do not explain the host's network interruptions.
- The test harness now forwards its own loopback HTTP through Playwright's
  request client with zero retries. It retains real service responses, signature
  checks, transactions and settlement assertions. Browser network transport and
  actual wallet extensions remain outside that automation boundary. These host
  failures remain recorded as failed/flaky runs, not erased by a later pass.
- Read-only deployed-UI browser smoke: passed against the served wallet-funding
  build. Synthetic asset/setup responses exercise missing funds, separate faucet,
  version-6 migration, pending/replacement tracking, wallet switching, cross-tab
  restart and 390/320-pixel layout. No signatures or send methods were requested.
  This does not modify the user's browser state or establish live deployment.

Detailed evidence lives under `.runtime/treasury-wallet-funding-20261021`,
`.runtime/treasury-deployment-batches/anvil-YyGsYy`, and the native run directories.
These ignored paths are local-only; the compact hashes and results here do not
make bulk logs/databases available to another checkout.

## Account selection and operations

The user explicitly selected the existing test-workload account referenced by
`SOURCE_PK` in the protocol checkout's `chain.env`. Its public address is
`0x2A8dd7551eF6Fc95000C76F2A0e7848A4bA5E73e`. Only that selected key is read, through
an ephemeral owner-only file, under the existing workload lock. It is not copied
into the browser, committed records or Docker configuration.

An earlier broad credential lookup was rejected by automatic approval review and
did not execute. The later explicit account selection authorized only this
workload account. Public RPC preflight found no pending nonce gap on either chain
and enough gas for the first simulated deployment. No account funding or state
override was performed.

Live deployment and UI rollout completed; verified records follow below.

## Limits

Test USDC remains a test faucet asset, not Circle-issued USDC. The treasury bridge
still extends the pinned test bridge; standard ERC-20 setup does not make it a
production bridge. Mainnet/Circle-USDC integration, actual wallet-extension and
Safe-app rehearsal, and completing the user's treasury remain separate work.

## Local UI rollout

Built `eez-rollup-ui:treasury-wallet-funding-20261021` and applied an image-only
Compose overlay. Rendering before/after proved `services.ui.image` was the only
configuration difference. Recreated only `ui`, with `--no-deps --no-build
--pull never`. Served entry assets match `dist`. Node, signer and monitor
container IDs/start times/images are unchanged, as is served runtime config SHA256
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.
See [sanitized UI verification](ui-verification.json).

The first post-rollout check assumed a host `.runtime/config.json` path and
failed after the UI was updated. Verification was completed against the actual
served, container-generated public config; no configuration was replaced.

## Live infrastructure deployment

Three transactions completed through the dashboard's normal RPC/Composer routes,
under the selected account's workload lock. Every step was reconciled against its
exact transaction and safe canonical receipt before advancing. The temporary
key file and CLI lock were removed on successful exit.

| Contract | Address |
| --- | --- |
| Chiado Test USDC | `0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb` |
| EEZ-X wrapped Test USDC | `0xdc207D5CE4e36560aD9f941Dd7A0a37cB5174c32` |
| Chiado bridge | `0x7F772f334b9a97C514A89FfD004AFcEAF5DDF789` |
| EEZ-X bridge | `0x976BF7AEB2b24291970965C8035687a1926a0B35` |

| Step | Chain | Transaction |
| --- | --- | --- |
| networkL1 | l1 | `0xa6af32d0db3a21e8531910b119164ad242abb6abbfdb0cd85351e387e883ce70` |
| networkL2 | l2 | `0xc5ffb4a76e1bb19c417fb38ddf2a88ed14933e177e8a541df093daf05c074e1a` |
| networkConnectL1 | l1 | `0x62c5a9e34410c840f7e9ef1ffd6c1f83e53dcada7da4c50924a89ecf7fd3613f` |

[Canonical verification](live-verification.json) includes receipt blocks, code
hashes and the registration identity. Both peers are sealed. One base unit
(0.000001 Test USDC) is locked in escrow and exactly one wrapped base unit is
held by the deployment account. The remaining 449.999999 constructor tokens are
in that account on Chiado. Neither executor holds tokens; the seed approval is
consumed and the Chiado executor is closed. No user Safe or user faucet claim
was created by this operation. The treasury setup client independently discovers
the same four live addresses.

The separate [live browser check](live-browser.json) uses actual canonical RPC
responses for all asset discovery and validation, with an injected read-only
wallet. A fresh browser setup selects version 6 and exactly this shared pair;
zero signatures or transactions were requested. It does not inspect or modify
the user's own saved setup, and does not replace an actual wallet rehearsal.

## Final native regression

Run `20261021T105557-n74oh1oo` passed: one intended Rust process test, zero
failed/ignored, 869.64 seconds, nine recorded semantic cases. The longer duration
includes waiting for the next natural ten-minute budget period; no time override
was used. `scenarioComplete`, `verified`, independent replay and posted-attestation
verification are all true.

The new standard funding path consumed exactly 450000000 units from the fixture
wallet, consumed its approval, and left canonical supply unchanged. Existing
owner addition/removal, 40 local, 110 split to L1, rejected extra 1, 10% paying 30,
110 split to EEZ-X, late invoice rollback and preparation rejection all passed.
History retained four settlements, three preparation rejections and one rollback.
The test still checks an independent follower and posted proof attestation.

[Native verification](native-verification.json) records exact executable/source
identities and semantic checks. This is a pass after the test transport fix; the
three original failed/flaky runs remain retained and are not reported as passes.
The network forwarding workaround changes only the browser harness, not the
application's RPC, signing, contract or protocol behavior.
