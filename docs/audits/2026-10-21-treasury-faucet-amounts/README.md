# Configurable Test USDC faucet

The faucet accepts a positive amount with up to six decimals, an arbitrary
recipient address, and Chiado or EEZ-X. Existing balances and prior requests do
not restrict eligibility. Each request adds exactly the selected amount.
Treasury setup remains separate; a Safe can be chosen directly as recipient.

The existing immutable token issues fixed 450-token claims.
`TestUSDCFaucet` refills through fresh `TestUSDCClaim` callers and keeps excess
for later permissionless requests. It pays locally or locks tokens through the
existing shared bridge. It has no Safe authority and accepts no user deposits.
The first request prepares the dispenser, then sends tokens; subsequent requests
reuse it. The call-only fee API is retained, so EEZ-X delivery uses a bound fee
quote after deployment. There is no wallet cap or cooldown; transaction gas
limits still apply to large requests.

Pending parameters and transaction identity are preserved across reload. The
UI confirms a delivery only after matching canonical receipt, runtime/bindings,
delivery event and exact transfer/lock. Old direct/fixed-claim pending calldata
and hashes remain unchanged. All 23 existing browser contract artifacts are
byte-identical; only the dispenser artifact was added. Older UIs reject the new
request identifiers, so downgrading during a pending request is unsupported.
See the [accepted proposal](../../proposals/one-treasury-two-safes.md#accepted-configurable-test-faucet-2026-10-21)
and [runbook](../../runbooks/treasury-shared-network.md#requesting-more-test-usdc).

## Identity and validation

Dashboard base `0d26cf24d2fa23de31021d1a508f137e24804efd`, branch
`feat/treasury-demo`, retaining unrelated uncommitted work. Protocol
`855fe0602484750861b4c31502a1a91355d33ed6`; Safe
`bf943f80fec5ac647159d26161446ac5d716a294`; modules
`c95f03900bff99be090dadb9de1c74b162365485`. Foundry 1.7.1 and the pinned
Solidity 0.8.34 settings. No protocol, token, bridge or Safe deployment is changed.

- `npm test`: 369 passed, no failures/skips. Covers decimals and overflow,
  request identity and history, confirmation events, exact transfer/lock,
  orphan receipts, legacy recovery and repeats.
- `forge test --root contracts`: 191 passed, no failures/skips. The new dispenser
  cases cover arbitrary/funded recipients, amounts requiring multiple claims,
  pooled remainder reuse, both routes and rollback after a mock bridge locks
  tokens then reverts. The exact-amount fuzz case runs 256 inputs.
- `node tests/integration/treasury-deployment-batches.mjs`: 19 cases verified in
  `anvil-CRFNPi`. The production client prepares, signs and reconciles requests
  against real token/bridge contracts, with reload, exact decimal credits and
  backing checks. Safes and budget counters remain unchanged. This harness uses
  one EVM, read-through managers and fixture fee responses, not native proofs.
- `node tests/treasury-faucet-browser.mjs`: five scenario groups passed, desktop
  and mobile screenshots inspected. Real React/request-plan code with controlled
  wallet/RPC responses; no live wallet writes. Includes pending reload, invalid
  input, repeated requests, cancellation, uncertain responses, wrong-network
  handling and account changes during the prompt.
- Production build, Foundry formatting, generated artifact consistency and
  `git diff --check` pass. The existing Vite bundle-size advisory remains.

The first contract run hit Foundry's removed `testFail*` naming convention; the
name was corrected. An initial TypeScript build used an array method outside the
project's target library; it now uses indexed access. The expanded Anvil suite
found an old expected setup version (8 versus the current 9), corrected without
changing the setup implementation. The browser account-change case exposed a
React update timing gap: explicit provider account checks now run before and
after preparation, and the same regression passes. First failures are retained.

The first native run (`20261021T204632-a2i1c1vw`) reached the faucet after the Safe
matrix but failed at `eez_quoteFee`: this pinned runtime exposes no such RPC. The
native faucet test now uses the same signed transaction/admission helper as its
existing Safe tests. It does not claim modern fee-RPC coverage and does not alter
production code or introduce a fallback there. Fee binding is separately checked
in the client/Anvil suite with fixture pricing. A read-only probe of the current
local dashboard's live L1 endpoint confirmed the method exists, but its
zero-token self-transfer quote was rejected as `unsupported_transaction` during
gas estimation/effect validation. That probe does not validate a live faucet
quote. No live request was signed or broadcast.

## Native validation and local rollout

`python3 scripts/run-treasury-integration.py --runtime /home/edu/Development/rollupX
--reuse-run .runtime/treasury-integration/20261021T200329-givcr3d3` passed in a fresh
isolated devnet (`20261021T205237-nrg23lqe`), 1 selected process test,
zero failures/ignored, 220.68 seconds. Runtime source and executable identities
matched the previously verified artifacts; the runtime checkout was not edited.
The fixture exercised real native Composer admission, proof signing and follower
replay. It delivered 1,000.123456 on EEZ-X, 17.123456 to an already-funded Chiado
recipient, and another 2.345678 to the same EEZ-X address. Exact recipient credits,
canonical receipts, bridge escrow/backed supply, cleared approval and unchanged
Safe balances/shared spending were asserted. The follower reproduced the EEZ-X
credits independently. The fee-RPC limitation above remains outside this native
coverage; no public browser-wallet faucet request was executed.

Only the local UI was replaced with `eez-rollup-ui:treasury-faucet-amounts-20261021`
(`sha256:b5d1bb7ee4337b274caf9ecef3019d6a1e138ad9b91e30d5471e4214c41c1b19`). Health is 200; served treasury assets match the
validated build byte-for-byte. Runtime config hash remains
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`; monitor, node and signer identities were
verified unchanged. Browser treasury state and public contracts were preserved.
The connected wallet performs the one-time dispenser preparation and later
requests; the agent signed no public faucet transaction.

Local-only evidence (ignored, unavailable in another checkout):

- `.runtime/treasury-faucet-amounts-20261021/validation.json`, `source-hashes.json`,
  `deployment.json`, logs and inspected browser screenshots.
- `.runtime/treasury-deployment-batches/anvil-CRFNPi/summary.json`: 19 verified
  cases, 60 real EVM transactions, with fixture fee responses.
- `.runtime/treasury-integration/20261021T205237-nrg23lqe/summary.json` and `scenario.json`: exact native source/executable
  identity, canonical balances and independent replay.
- `.runtime/treasury-integration/20261021T204632-a2i1c1vw/`: retained first native
  failure/logs/datadirs. The corrected run changes only the test's unsupported
  fee-RPC invocation, not production fee checks.
