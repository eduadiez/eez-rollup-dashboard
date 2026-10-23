# Automatic treasury source verification — 2026-10-22

Implemented and deployed to the local dashboard for new treasury releases.
Historical contract backfilling is excluded. Exact original metadata for one
inherited Chiado registry proxy variant remains unavailable; publication for a
new alias with that variant is reported as needing its source build, not as
verified. Explorer outages remain retryable publication limits.

[Results](results.json) record the build, pins, image identities, checks and
isolated deployment addresses. The owning
[runbook](../../runbooks/treasury-shared-network.md#automatic-contract-source-verification)
describes build/release operations, compatibility, persistence and recovery.

## What changed

- A release contains 19 deployment contract types and three factory dependency
  builds, with immutable IDs, portable source names, exact compiler settings and
  retained standard JSON inputs. Each per-contract input is recompiled and must
  reproduce creation and runtime bytes including metadata before packaging.
- New setup journals select that release; existing journals retain their frozen
  bytes. Chiado setup version 10 and Ethereum version 2 prevent older clients
  from interpreting those new plans. Mainnet and Chiado configuration remain
  separate. No Solidity implementation or protocol pin changed.
- Confirmation records verification intent atomically with the setup journal;
  the browser retains an independent outbox across Start new treasury, delivers
  immediately, and retries failures. Handed-off work persists in the worker's
  volume and survives browser/worker restarts.
- The worker validates network identity, canonical receipts and exact code, and
  discovers ordinary deployments, batch creations, Safe factories, protocol
  aliases, wrapped tokens and constructor-only faucet helpers. Submission is
  idempotent. Partial matches and queued jobs never count as full verification.
- Exact Sourcify runtime matches remain distinct from explorer publication and
  creation verification. Errors retry with backoff; unavailable exact inputs are
  visible. No new environment variables, private keys or wallet prompts.

## Validation

- `npm run check:treasury-release` and `npm run build`: passed. The frontend
  checks deployment/verifier bundle integrity without needing Solidity in its
  Docker image. Existing Vite large-chunk warnings remain.
- `npm test`: **415 passed**, including **14 source-verification tests** for
  exact metadata gating, nested creation discovery, duplicate admission, restart
  recovery, provider failures, reorgs, partial matches, network isolation,
  unmined receipt rejection, outbox retention and published bundle integrity.
  Existing mirror reuse also accepts its frozen, reviewed adapter build and
  rejects changed metadata or inconsistent immutable values.
- `forge test --root contracts`: **204 passed**, no skipped tests.
- `node tests/integration/treasury-source-verification.mjs`: six real contracts
  deployed on an owned Anvil; submitted inputs recompiled by the real Solidity
  compilers matched deployed metadata/code. Covered factory and batch children,
  pending-versus-complete status and persistent worker restart. Explorer
  transport was controlled; this is not a live public explorer acceptance test.
- `node tests/integration/treasury-deployment-batches.mjs --current-release`:
  passed real Safe setup, owner authorization, zero-funding setup, payments in
  both directions, shared-budget rejection and faucet cases with the new bytes.
  Its EEZ managers and fee responses are fixtures in one owned EVM with logical
  chain phases; it does not claim Composer/prover or independent replay coverage.
- Setup completion, mainnet chooser and faucet browser regressions passed.
  These retained existing journals and validated wallet switching/recovery.
- Both Docker images built; the local UI and worker run the recorded image IDs.
  Worker health is ready. A live request for an unmined transaction was rejected
  without creating a job; the live queue contained zero historical jobs.
- `.env`, both network profiles, legacy Chiado and mainnet artifact bundles, and
  the running UI's runtime configuration remain unchanged. No live blockchain
  deployment, funding, signing or historical verification submission occurred.
  The public mainnet site and protocol services were not redeployed.
- `git diff --check`: passed.

Initial failures were retained locally: three state round-trip tests exposed
explicit `undefined` properties in legacy records; those properties are now
omitted. The isolated harness initially read a receipt before it was mined and
now polls explicitly. The current-release integration initially expected the old
journal version and now checks the release-specific version. One browser launch
failed because its owned temporary directory did not yet exist; creating it
avoided the system `/tmp` quota. These were corrected before the reported passes.

Detailed local-only logs are under `.runtime/treasury-auto-verification-20261022/`.
The current-release Safe setup integration is under
`.runtime/treasury-deployment-batches/anvil-MRit3Q/`. Its tested creation/runtime
bytes equal the final release byte-for-byte; later packaging only narrowed verifier
inputs and added exact factory dependency inputs. The final source verification
integration ran against the final release ID recorded in results.json; its
latest evidence is `.runtime/treasury-auto-verification-20261022/anvil-jzj9W5/`.

This validates a source-publication workflow. It is not a security audit, a new
mainnet rehearsal or proof that third-party explorers will remain available.
