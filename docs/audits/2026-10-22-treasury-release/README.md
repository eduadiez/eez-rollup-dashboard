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

## Cleanup follow-up

Reviewed from `48d6f771e64de8769ff72fc557d7c05670d599eb`. Removed the two obsolete
standalone browser-artifact generators, which could overwrite frozen setup
bundles. The integration source inventory now records the immutable release
tools and selected build instead. Removed nine unused CSS classes from the old
simulation/history layout and corrected current documentation for existing-Safe
selection, separate funding, current controls and release status. Dated design
and validation history remains available.

All 433 JavaScript tests, TypeScript/Vite build and release integrity checks pass.
The existing connected-view browser regression passes the same 15 cases before
and after cleanup, including mobile layouts, history, split diagrams, reorg/RPC
recovery and internal transfers. Its providers are controlled. Python syntax,
all 148 source-inventory paths, local documentation links and whitespace pass.
The nine preserved operator/profile/artifact inputs still match their recorded
hashes; deployment bytecode and build identity are unchanged.

Logs and browser results are local-only in
`.runtime/treasury-cleanup-20261022/`. Solidity, native process and service-image
checks were not repeated for this CSS, inventory and documentation cleanup.
The earlier results above retain their original scope. No running service or
chain state was changed, and the publication checks remain outstanding.

## Shared setup cleanup

From `53d07cf7eeefe117850bd558d7851432a0b3ce31`, extracted contract reads, artifact
checks and pending-transaction discovery into `DeploymentIO`. Ethereum setup now
uses those shared operations directly instead of constructing the Chiado planner.
The moved method bodies, timeout, recovery window and artifact checks are
unchanged. Safe inspection and mirror-call lookup use narrower read interfaces.
Internal transfers reuse the existing Safe batch encoder, retaining lowercase
calldata for saved requests. No setup schema or deployment artifact changed.

Validation: all 434 JavaScript tests, TypeScript/Vite build, release integrity,
19 isolated Anvil setup scenarios and three browser regressions pass. The Anvil
suite exercises real Safe batches, saved progress and payments in both directions
with fixture EEZ managers; the browsers use controlled providers. Sixteen transfer
vectors retain exact serialized calldata and Safe signing hashes. An initial
hex-casing difference was corrected, with a fixed signing-vector regression added.
Python syntax, 149 source-inventory paths, local links, whitespace and all nine
preserved input hashes pass. Existing bundle-size warnings remain.

Logs, comparison vectors and initial failures are local-only in
`.runtime/treasury-cleanup-2-20261022/`; the isolated integration evidence is in
`.runtime/treasury-deployment-batches/anvil-MziVzo/`. Contract, native process and
service-image suites were not repeated for this application refactor. Running
services, chain state and the outstanding publication checks are unchanged.


## Final review

Reviewed from `b9db5f6147e3218ddf305b80219c7fc7f92d7c2c`. A public HTTPS fetch
confirmed that `origin/main` remains `fb6b798249464cea96f41703adeb0f28da262b20`,
already integrated. Review covered the owner adapter, payment/delegate boundaries,
setup and receipt recovery, mainnet bindings, retained source builds, browser
verification delivery, worker admission and service/CI wiring.

Two issues were corrected:

- Browser verification delivery stopped at the first failed request. An unavailable
  receipt could indefinitely prevent later deployments from reaching the worker.
  The browser now retains that request and displays its retry status while
  delivering later requests. The new browser regression failed on the baseline
  with only the first request attempted, then passed all three cases: independent
  delivery, automatic timed recovery and eventual completion without losing the
  outbox. HTTP responses are controlled; this is not live explorer evidence.
- The CI artifact step now explicitly includes hidden files so its `.runtime/`
  evidence is retained. The [upload action's default](https://github.com/actions/upload-artifact/blob/v4/action.yml)
  excludes hidden files. The upload remains scoped to the isolated CI output
  directory; operator configuration is not included. The browser regression is
  also part of the PR workflow.

Current validation: 434 JavaScript tests and 204 Solidity tests pass with no
failures or skips; Solidity formatting, three new browser cases, release integrity,
TypeScript/Vite, both Node-22-based service image builds, Compose configuration,
workflow parsing and whitespace checks pass. The deployment build identity and
all nine recorded configuration/profile/artifact hashes remain unchanged.
Existing Vite chunk-size warnings remain. The owned browser/server exited.

Exact image identities are in [results](results.json). Initial failure
and final logs are local-only under `.runtime/treasury-final-review-20261022/`.
Native Composer/follower, real-USDC fork and public-chain acceptance runs were
not repeated for this browser retry/CI fix; earlier evidence retains its original
scope. Hosted CI still requires the user's push/PR. No services were restarted,
no public-chain transactions were sent, and no push or PR was created.

No remaining push/PR blocker was identified in the reviewed paths. The publication
checks above remain open. In particular, the inherited Chiado factory metadata
gap affects newly created aliases too; dropping historical backfill does not
resolve it. Mainnet release still requires independent contract review and the
real-wallet/Safe-app acceptance.

## Safe 1.5.0 compatibility

The mainnet address `0x1a38210B3330aa0B41267D605f14C699A7189b60` exposed a
missing supported version after the review above. At Ethereum block **26250717**
(`0x0f1c0f8399b99b0c666fa9985e11af470a8fcab3612a1cdaec0a6fd883af12a6`),
the original inspector at `c9e4a87b48f3e6a722a7090f12123dbaecc0c1d8` rejected its
proxy; the updated production inspector accepted the same address and block.
These were read-only calls through the public mainnet dashboard's configured RPC.
The observed Safe has one owner, threshold one, nonce zero and no enabled modules,
transaction Guard or module Guard.

The Safe uses official 1.5.0 implementation
`0xFf51A5898e281Db6DfC7855790607438dF2ca44b`, code hash
`0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2`.
Its new proxy hash is
`0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f`.
The runtime matches the published
[Safe deployment catalog](https://github.com/safe-global/safe-deployments/blob/8e200b0b4c72dbbfe371cbd61b3a21ae2ec4af62/src/assets/v1.5.0/safe.json).
The pinned [fixture](../../../contracts/test/fixtures/safe-150.json) contains both
1.5.0 singleton variants and the proxy, from the integrity-checked
`@safe-global/safe-smart-account@1.5.0` package. Source revision:
`dc437e8fba8b4805d76bcbd1c668c9fd3d1e83be`.

The fix admits these official runtimes for an existing L1 Safe and rejects
nonzero module Guards. It retains bytecode identities, canonical-block checks,
EOA-quorum restrictions and version checks on setup and reopening. Mirrors remain
1.3.0/1.4.1: the existing adapter calls the retained legacy L1 verification
interface, but does not implement the modern contract-owner interface required
by a 1.5.0 mirror. No production Solidity or immutable build changed.

Validation of this patch:

- The focused JavaScript baseline had 35 passes and three failures: both official
  1.5.0 proxy imports and reopening a treasury with that L1 version. All 38 cases
  pass after the change, including modified-code rejection, false versions,
  module Guards, unsupported mirrors and exact event layouts.
- `npm test`: **440 passed**, zero failures or skips.
- `forge test --root contracts`: **234 passed**, zero failures or skips. The 30
  added cases deploy the real published 1.5.0 Safe/SafeL2 bytecode and exercise
  current-owner verification, threshold changes, official allowance modules,
  both payment initiators and destinations, shared limits and rollback. These
  reuse read-through EEZ manager fixtures; they are not Composer/proof tests.
- `forge fmt --check --root contracts`, `npm run build`,
  `npm run check:treasury-release` and `git diff --check` pass. The existing Vite
  bundle-size warning remains. All nine preserved configuration/profile/artifact
  hashes are unchanged, as is release
  `3069fa624a1ebaa01e6528033478c7f10d5263542f01c873a6043dfe0503a60d`.

Detailed logs and the before/after RPC observation are local-only under
`.runtime/treasury-mainnet-safe-20261022/`. This run did not repeat native EEZ
process tests, browser wallet acceptance or a real-USDC fork rehearsal. No public
transaction, Safe upgrade, contract deployment, service rollout or push was made.
The updated dashboard must be published before the reported Safe works in the
hosted setup form.
