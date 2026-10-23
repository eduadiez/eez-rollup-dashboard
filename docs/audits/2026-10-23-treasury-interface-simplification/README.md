# Treasury interface and owner-adapter simplification

## Scope and identity

This follows the accepted [interface and adapter scope](../../proposals/one-treasury-two-safes.md#accepted-interface-and-owner-adapter-simplification-2026-10-23).
Work stays in `eez-rollup-dashboard`, on `codex/treasury-demo-release` at
`a96bc5cd3e7df91ac585ce7cdf6303f82fc7bfb6`.
The previous uncommitted policy consolidation was the baseline and is preserved.
No public contracts, network profiles, environment settings or services changed.

Core remains `855fe0602484750861b4c31502a1a91355d33ed6`, Safe
`bf943f80fec5ac647159d26161446ac5d716a294`, and modules
`c95f03900bff99be090dadb9de1c74b162365485`. Isolated execution uses runtime
`fa916b13254a36423cad130080dde367bb18a7d6`, with its source and executable
inventories verified before reusing the previous run's binaries.

New immutable release:
`9b7548e5819f28db77942f4ae00401d38f6cdd8e35e08673e3261af8ca506178`.
Existing releases, including the previous local build `facdeca2712465daf5ea77052c6d4b71547d454ae83ad6b78aa9c03c11f77424`, remain unchanged.

## Changes and limits

- Current fixed and percentage entry points omit the token argument. The signed
  policy target binds its immutable asset. The client checks that binding before
  submission and validates `SPLIT_VERSION = 2` against manifest `abiVersion: 2`.
- One `GLOBAL_LIMIT` constant bounds both the amount and cumulative spending.
  Authorization, checked narrowing, epoch, capacity, recipient and rollback checks
  remain. The isolated invoice fixture retains its explicit asset check.
- `TreasuryBootstrap(actions)` records `msg.sender` as owner. Caller/sequence
  checks, batch atomicity, expected CREATE addresses and permanent closure remain.
- New selection on Chiado and Ethereum extends the existing bootstrap-log search
  to reuse an owner adapter for the same original Safe and local manager. Logs
  only identify candidates: runtime and immutable consistency, actual bindings,
  registered Safe proxy and a stable canonical block are required. Read failures
  do not authorize redeployment. Existing mirror selection retains its adapter.
- Historical manifests retain their selectors; saved setup journals select their
  original immutable artifacts, including the two-argument bootstrap constructor.
  New selectors cannot execute against an old signed transaction or be substituted
  during recovery. There is no automatic migration.

Compared with the preceding build, runtime size is 11,147 -> 10,141 bytes for the
Chiado policy and 8,737 -> 8,412 for the standard-bridge policy. Bootstrap runtime
remains 1,652 bytes; its creation input is simpler. The adapter and all four shared
Safe helpers retain identical creation and runtime bytes. Adapter reuse saves one
contract creation for a later mirror of the same Safe, not a wallet confirmation.
The existing owner-verifier/policy/bridge-delegate separation is retained.

## Validation

| Check | Result |
| --- | --- |
| Focused baseline | 39 JavaScript and 65 Solidity tests passed before edits. |
| `npm test` | 448 passed, none failed or skipped. |
| `forge test --root contracts` | 143 passed, none failed or skipped. |
| `npm run build` | TypeScript/Vite passed; existing import/chunk warnings remain. |
| `npm run check:treasury-release` | Exact sources, compiler inputs and 18 artifacts agree. |
| `forge fmt --check --root contracts`; `git diff --check` | Passed, including the final evidence update. |
| `node tests/integration/treasury-deployment-batches.mjs` | 19 cases passed, including actual adapter reuse, existing-Safe adoption, no-funding setup, both split destinations, budget rejection and faucet behavior. |
| `node tests/integration/treasury-source-verification.mjs` | Six real local creations verified through exact recompilation, nested discovery and restart recovery; explorer transport is controlled. |
| Standard-bridge native rehearsal | Passed both signing Safes/destinations, 40/110/rejected-1, percentage payment, browser/reload recovery, late USDC failure rollback and independent follower replay. |
| Chiado native rehearsal | Passed live owner addition/removal, stale/replayed approval rejection, both signing Safes and destinations, budget rejection, faucet transfers and independent follower replay. |

A new regression deploys two real mirror Safes with one adapter, rejects a
signature replay between them, and observes a changed L1 threshold on both.
Discovery tests reject wrong Safe/manager/proxy identities, forged creation logs,
missing proxy code, RPC uncertainty and reorgs. Old payment selectors are rejected
by the new policy without balance or counter changes. Saved payment hashes remain
valid only with their original ABI, for both initiating Safes and destinations.

The first added JavaScript recovery test omitted the L2 observation required for
an L1-origin intent and failed for that reason. Adding the missing fixture field
allowed it to reach the intended ABI-mismatch rejection; production recovery was
unchanged. The full suite then passed. Two initial shell log-capture attempts
returned exit 1 without diagnostics; they are not counted as baseline passes.
The direct baseline commands above passed.

## Reproduction and local evidence

Run from the dashboard root:

```bash
npm test
forge test --root contracts
npm run build
npm run check:treasury-release
node tests/integration/treasury-deployment-batches.mjs
node tests/integration/treasury-source-verification.mjs
python3 scripts/run-treasury-integration.py --runtime ../rollupX \
  --reuse-run .runtime/treasury-integration/20261022T232301-x9nfvso5 \
  --standard-bridge-snapshot .runtime/treasury-integration/20261022T223230-n4c03kfm/mainnet-snapshot.json
python3 scripts/run-treasury-integration.py --runtime ../rollupX \
  --reuse-run .runtime/treasury-integration/20261023T065350-er20ywi2
```

Local evidence: `.runtime/treasury-simplification-followup-20261023/`,
`.runtime/treasury-deployment-batches/anvil-Q5FnVu/`,
`.runtime/treasury-auto-verification-20261022/anvil-HpLNgG/`, and native runs
`20261023T065350-er20ywi2` (standard) / `20261023T065842-2nkwzxjy` (Chiado).
These ignored paths and snapshot/binaries are local-only. A fresh checkout uses
the [integration guide](../../../tests/integration/README.md) to build its own
pinned environment; unrelated cached executables are not a substitute.

The setup test uses one real EVM with two logical chains and read-through manager
fixtures; it does not establish protocol settlement. Native rehearsals exercise
Composer, signer, independent replay and posted-attestation verification on
disposable chains. The Chiado native run is scripted; the full Chiado browser
rehearsal was not repeated for this interface-only follow-up. The standard case
uses captured public bridge/USDC runtime bytes with newly initialized local state,
not public balances or authority. Browser signing uses controlled EIP-1193 fixture
wallets. Public transactions, actual extension/Safe-app acceptance, a fresh live
mainnet fork and an independent security audit were not performed. The contracts
retain their unaudited-demo notices.
