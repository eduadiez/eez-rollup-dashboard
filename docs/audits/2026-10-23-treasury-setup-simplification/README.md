# Direct setup and payment model — 2026-10-23

## Scope and identity

Implements the [accepted simplifications](../../proposals/one-treasury-two-safes.md#accepted-direct-setup-and-payment-model-2026-10-23): direct new setup, one fixed-payment format and removal of obsolete bridge wrappers. All work stays in `eez-rollup-dashboard`. Earlier uncommitted simplifications are the baseline and are preserved.

- Branch: `codex/treasury-demo-release`; HEAD: `a96bc5cd3e7df91ac585ce7cdf6303f82fc7bfb6`.
- Core: `855fe0602484750861b4c31502a1a91355d33ed6`; Safe: `bf943f80fec5ac647159d26161446ac5d716a294`; modules: `c95f03900bff99be090dadb9de1c74b162365485`.
- New immutable release: `026c1f779c5c3bed2cc56f91707bb7b9eca67c240ef7cfd47ca83017cb868df1`.
- Previous release: `ef44a9ce1e7823ab2e76549a3773ef68d5f1a483b866c74856dcaafabaaf51ac`.

## Changes and compatibility

New shared-network setup creates a flat version-11 journal directly. It freezes the selected Safe, verified shared helpers, asset and bridge bindings before signing. The five base batches connect the mirror and configure spending; existing-Safe adoption and occupied CREATE addresses retain their required extra steps. Setup creates neither a token nor a bridge pair and moves no funds. The existing mainnet setup flow remains separate.

New fixed payments carry an amount and exact original-chain contribution. One contract-interface version replaces current capability flags. The split slider, either initiating Safe, either destination, shared owners and thresholds, allowances, shared budget, internal transfers, faucets, history and isolated invoice rollback remain.

`ConfiguredTreasuryBridge` and `BootstrapTreasuryBridge` are no longer compiled. `SharedTreasuryBridge` owns their constructor initialization directly. It is the only contract whose creation/runtime bytes change in this release; policy, owner-adapter and official infrastructure bytes remain identical.

Existing setup journals select their original planner and immutable artifacts through `savedDeployment.ts`. Existing payment manifests, hashes and calldata are read through `savedPayments.ts` without rewriting their stored shape. Older one-way policies retain their initiating-chain restriction. Archived shared-bridge runtimes are matched exactly, including metadata and immutable consistency; manager, token, frozen peer and canonical-block checks remain independent.

Uncertain submissions remain pending even when the wallet returned no hash. Only a matching explicit wallet rejection can clear an unhashed request for retry. Submitted/replacement hashes, confirmed steps and selected contracts cannot be silently replaced. No browser storage was cleared, public contract was changed or operator transaction was submitted. The six recorded network/infrastructure profiles and legacy artifact bundles are byte-for-byte unchanged; `.env` and shared services were not modified.

## Validation

The unmodified task baseline passed 440 JavaScript tests. Migration-only tests were replaced with direct-plan and saved-request regressions. Saved setup vectors are generated from the preserved pre-refactor planner, including step order, calldata hashes and batch output commitments; no tests are marked skipped to reduce that count.

| Check | Result |
| --- | --- |
| `npm test` | 420 passed; none failed or skipped |
| `forge test --root contracts` | 134 passed; none failed or skipped |
| `npm run build` | TypeScript/Vite passed; existing import/chunk warnings remain |
| Release and formatting checks | 18 exact source/artifact pairs; `forge fmt --check` and `git diff --check` passed |
| Setup integration | 19 cases: direct setup, reused infrastructure, existing-Safe adoption, both split destinations, budget rejection and configurable faucet |
| Source verification integration | Six actual Anvil creations; exact recompilation, nested discovery and restart recovery; explorer transport controlled |
| Focused browser checks | Setup completion/reload/pending behavior; payment signing, network prompts, older one-way treasury, exact slider values and internal transfers |
| Full native browser rehearsal | Owners, both initiating Safes and destinations, budget reset/rejection, invoice rollback and payment history; independent follower replay and posted attestation verified |
| Standard-bridge rehearsal | Captured bridge/USDC runtimes, both directions, owner changes, reload/lost-response recovery and late USDC failure after an earlier successful release; independent replay verified |
| Final native rehearsal | Corrected production sources passed both initiating Safes/destinations, owner checks, faucet, budget rejection, independent replay and posted attestation |

First failures are retained. The initial native preflight referenced a removed bridge source; updating its source inventory fixed the launcher before either devnet started. A focused browser test then exposed the older one-way initiation gate. Review also found that the stricter journal write guard blocked explicit wallet cancellation. Both were reproduced with targeted regressions and corrected. One added assertion initially read a nonexistent `.safe` field instead of the typed-data domain's `verifyingContract`; correcting the assertion does not change production behavior. The browser fixture now exercises the current interface plus a separate older one-way manifest.

Full-browser and standard rehearsals completed before those final client compatibility fixes. The final native run uses the corrected production sources; the focused browser suite repeats the affected UI behavior. Any remaining differences in the recorded source inventories are listed in [results.json](results.json), rather than presenting earlier results as an exact final snapshot.

## Reproduce and limits

Run from the dashboard root:

```bash
npm test
forge test --root contracts
npm run build
npm run check:treasury-release
node tests/integration/treasury-deployment-batches.mjs
node tests/integration/treasury-source-verification.mjs
node tests/treasury-wallet-browser.mjs
node tests/treasury-setup-completion-browser.mjs
python3 scripts/run-treasury-integration.py --runtime ../rollupX --ui test
```

The executed native runs reused exact verified binaries from `.runtime/treasury-integration/20261023T065350-er20ywi2`; source and executable hashes were checked before reuse. Runtime HEAD is `fa916b13254a36423cad130080dde367bb18a7d6`, with its existing local edits recorded by the launcher. The standard run used the retained snapshot at `.runtime/treasury-integration/20261022T223230-n4c03kfm/mainnet-snapshot.json`. A fresh checkout must follow the [integration guide](../../../tests/integration/README.md) to build its own pinned environment and capture a snapshot.

The Anvil setup tests use one EVM with two logical chains and controlled cross-chain reads; native tests supply real Composer/signer execution, canonical settlement and independent replay. Browser providers use fixture keys, not real extension dialogs. The snapshot provides real public runtime bytes with fresh isolated state, not a fresh mainnet fork or production acceptance. Public explorer publication, an actual wallet/Safe-app rehearsal and an independent security audit were not run. Demo/unaudited contract notices remain.

Detailed local evidence paths, hashes and results are in [results.json](results.json). Ignored `.runtime/` logs and datadirs are local-only and unavailable to another checkout. No public deployment or local dashboard service update was requested for this pass.
