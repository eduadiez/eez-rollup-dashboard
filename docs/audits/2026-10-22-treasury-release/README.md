# Treasury PR preparation — 2026-10-22

Prepared on local branch `codex/treasury-demo-release`, integrating main at
`fb6b798249464cea96f41703adeb0f28da262b20`. The original feature HEAD was
`0d26cf24d2fa23de31021d1a508f137e24804efd`; the accumulated implementation is
preserved in `d39b5a5`, with main integrated by `21e9272`. No push, PR creation,
service rollout, public-chain deployment, wallet signing or funding is part of
this preparation. Local configuration, backups, saved network profiles and frozen
setup artifacts were preserved and excluded from incidental edits.

## Release changes

- The hidden treasury view and its contract/source bundles are committed with
  pinned Safe, Safe modules and core dependencies. Main's quote debugger and
  current dashboard behavior are retained.
- Public verification admission now requires newly observed code matching a
  retained build. Configuration-only transactions return `not-applicable` without
  consuming storage or claiming verification. Unknown code remains explicitly
  unresolved without allocating queue space. Events referencing an existing
  contract cannot consume slots merely by naming known bytecode.
- Discovery is bounded to 128 candidates and nginx limits verification requests
  independently from wallet RPC traffic. At capacity, completed results may expire;
  pending, unresolved and actively rechecking jobs remain owned by the worker.
  Expired results can be reconstructed through canonical redelivery. This retains
  compatibility with the existing queue and setup journals.
- The PR workflow checks Node 22, pinned Foundry 1.7.1, the immutable release,
  contract/unit suites, isolated deployment verification, setup batches, browser
  regressions and both Docker images. It does not publish images or contracts.

## Validation

- 433 JavaScript tests passed on both the local Node runtime and Node 22 in an
  isolated container, including 20 verification tests. Four new admission/capacity
  regressions failed against the baseline before the fix and then passed. A
  controlled-concurrency regression also checks that a result cannot be evicted
  while canonical rechecking owns it.
- 204 Solidity tests passed; zero failures or skips. Solidity formatting passed.
- Full release recompilation reproduced the same 19 deployment contract types,
  three factory dependencies and build ID without changing any retained bundle.
- Six actual Anvil deployments passed public admission, exact compiler-input
  recompilation, nested creation discovery and persistent restart recovery.
  Explorer responses were controlled; this does not certify a public verifier.
- The current-release Safe setup/batch integration passed, including both payment
  directions, the independent shared budget and faucet delivery. Its EEZ calls
  use fixtures; this run does not replace native Composer/proof/follower tests.
- Browser checks passed for completed-setup recovery, Ethereum Safe selection,
  faucet recovery, hidden treasury navigation/mobile layout and the merged quote
  debugger. These use controlled providers and do not sign on public networks.
- TypeScript/Vite and both Docker images built. Existing chunk-size warnings
  remain. An owned temporary UI container passed `nginx -t`; 48 rapid verification
  requests produced HTTP 429 while dashboard health remained available. The
  container was removed, and the running local deployment was not replaced.
- Source checks, Compose configuration, YAML parsing, whitespace checks and
  operator-file hashes passed. No environment backups, Python caches or runtime
  data are included in the branch.

[Results](results.json) retain the exact build, dependency pins, test counts and
image identities. Detailed logs remain local-only under
`.runtime/treasury-release-prep-20261022/`, with isolated source verification in
`.runtime/treasury-auto-verification-20261022/anvil-DdhCuO/` and setup evidence in
`.runtime/treasury-deployment-batches/anvil-F3hjHJ/`.

## Remaining publication checks

The hosted workflow will run only after the user pushes and opens the PR. This
preparation does not claim that CI has already passed on GitHub. Automatic source
submission still needs an acceptance run for a fresh deployment on the actual
Chiado and EEZ-X explorers. The existing Chiado factory's older alias metadata
remains an explicit source-provenance gap; no partial match is labeled verified.
A public mainnet release additionally needs the real-wallet/Safe-app acceptance
and independent contract review described in the
[mainnet record](../2026-10-22-treasury-mainnet/README.md#verification-and-limits).
The successful isolated native rehearsal there is distinct from those live checks.
