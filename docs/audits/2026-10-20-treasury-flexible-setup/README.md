# Selected-wallet deployment and existing Safes — 2026-10-20

The hidden dashboard setup selects its deployer from the connected wallet and
allows new or existing Safes independently on Chiado and EEZ-X. Existing L1
owners and threshold are retained. An existing EEZ-X quorum explicitly approves
one atomic transition to `L1Owners`, unless a matching adapter is already present.
Current owners approve subsequent Safe administration; a funded wallet may relay
those approvals. New L1 Safes start 1-of-1 with the selected deployment wallet.

**Implemented, tested and available in the local dashboard.** No shared-network application transaction has
been signed or broadcast by this task. Wallet-extension execution of the full
shared setup, hosted Safe-app support and shared payment settlement still require
a human rehearsal. Existing assets are preserved and excluded from the fresh
Test USDC policy. Limits remain 100 per Safe / 150 shared per ten minutes.

## Identity and scope

- Dashboard `feat/treasury-demo`, base `0d26cf24d2fa23de31021d1a508f137e24804efd`,
  with the existing application work and this increment; no unrelated work was
  discarded or committed.
- Core `855fe0602484750861b4c31502a1a91355d33ed6`, Safe 1.4.1
  `bf943f80fec5ac647159d26161446ac5d716a294`, AllowanceModule 1.0.0
  `c95f03900bff99be090dadb9de1c74b162365485`. Submodule worktrees remained clean.
- Foundry/Anvil 1.7.1; application Solidity 0.8.34, optimizer runs 1, via IR;
  unmodified Safe modules compiled with Solidity 0.7.6, optimizer off, Istanbul.
- Native test runtime `fa916b13254a36423cad130080dde367bb18a7d6`, including its
  recorded preexisting edits. Source inventory SHA-256
  `359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
  The shared runtime is a different build; see the
  [earlier network record](../2026-10-20-treasury-shared-network/README.md).

The application and tests remain in this dashboard repository. Native tests
read the runtime checkout and reuse verified executables; they do not edit it.
The Anvil setup test starts two processes on unused loopback ports, funds only
its public fixture wallets and terminates only those processes.

## Implementation and compatibility

The UI inspects Safe proxy and singleton execution code, Guard storage, current
quorum and any existing L1 owner adapter. Supported singleton code matches the
pinned local build or exact official Safe / SafeL2 1.4.1 hashes, documented in the
[contract guide](../../../contracts/README.md#selected-wallet-setup-and-existing-safes).
A `VERSION()` response alone is insufficient. Reused owner adapters require
consistent repeated immutable words and a live check of their deterministic,
registered L1 Safe proxy. Merely masking constructor values in runtime comparisons
would allow different getter/execution targets. Guards and unsupported
contract-owner quorums stop setup. EOA quorums include EIP-7702 accounts.

Safe's unmodified `MultiSendCallOnly` removes linked-list heads and swaps the last
owner for the adapter in one delegatecall. The old quorum authorizes that exact
Safe/chain/nonce transaction. Safe gas fields are zero to make required failures
revert its nonce. Existing native/token balances, modules and fallback handler
are not migrated. Owner changes remain possible through ordinary Safe authority;
the shared budget constrains policy payments only.

Version-2 journals include deployer, random salt, imported identities and current
approval round. Nonce/quorum changes invalidate approvals. Web Locks protect
journal updates; pending submissions require exact canonical receipt recovery
and matching Safe success events before advancing. Version-1 active journals
retain their original fixed owner, salt, addresses, pending request and history.
Older manifests remain readable; new manifests additionally bind Safe singleton
slots/code. An older UI cannot resume a version-2 setup.

## Checks and evidence

| Check | Result and scope |
| --- | --- |
| `npm test` | 258 passed, zero failed/skipped, on the final source |
| TypeScript / Vite build | Passed on final source; installed JS bytes match local output |
| Foundry formatting, contract suite | Passed; 55 tests, zero failed/skipped; mocked EEZ delivery |
| Generated browser artifacts | All 14 artifacts match the pinned Foundry output |
| Real Safe setup on two owned Anvils | Eight cases passed; [record](setup.json) |
| Read-only browser check | Final deployed UI, selected wallets, reuse controls, invalid import, reload, zero gas, mobile width; [record](browser.json) |
| Simulated preview browser | Passed hidden navigation, both destinations, budget sequence and responsive widths; no writes |
| Native browser regression | One test passed in 817.36 seconds, zero ignored/failed; [source/executable summary](native-summary.json), [scenario](native-scenario.json) |

The native run `20261020T174648-l9s0rhze` preserved its exact source snapshot and
passed semantic checks for owner verification, invoice inclusion rollback,
40 / 110 to L1 / rejected 1, natural reset, 10% paying 30, and 110 to EEZ-X.
Independent replay reached block 810 with the matching hash. History retained
four settlements, three preparation rejections and one verified rollback, with
zero automatic resubmissions.

The final imported-adapter checks were validated in an isolated copy while the
native run finished, then applied to the main source. Its six-file difference
from the native snapshot is explicitly recorded in [final sources](final-sources.json).
Those changes affect shared setup imports, artifact metadata and their tests;
payment/signature execution, application Solidity and runtime sources are
unchanged. Final-source Anvil tests, all unit tests, build/artifact checks and
the deployed read-only browser check cover that delta. There was no second native
run of the final shared-setup snapshot; the native result is evidence only for
its recorded source and the unchanged payment flow.

Commands run from this repository:

```bash
npm test
npm run build
forge fmt --check --root contracts
forge fmt --check --root contracts/legacy
npm run test:contracts
npm run check:treasury-artifacts
npm run test:treasury:setup
node tests/treasury-shared-browser.mjs
EEZ_UI_URL=http://127.0.0.1:8080/dashboard node tests/treasury-demo.cjs
python3 scripts/run-treasury-integration.py --runtime /home/edu/Development/rollupX \
  --ui test --reuse-run .runtime/treasury-integration/20261020T154209-7sciw1sf
```

The reuse directory and `.runtime/treasury-flexible-setup/` diagnostics are
local-only and unavailable to other checkouts. Omit `--reuse-run` to build exact
native artifacts following the [integration guide](../../../tests/integration/README.md).
Anvil setup checks use production TypeScript signing and receipt code with real
Safe contracts, but replace protocol discovery/checkpoints and omit intermediate
application deployments. They do not establish EEZ settlement. The separate
native test uses real Composer, signer and independent follower with an injected
wallet provider, not a browser wallet extension.

Retained first failures include:

- TypeScript nullable wallet-address checks and a target-library array method;
  corrected before browser validation (`build-first.log`).
- Unit/browser fixture checksum expectations; corrected without changing
  application address semantics (`focused-first.log`, `browser-first.log`).
- Anvil fixture receipt/safe-head timing; confirmed blocks and bounded receipt
  polling were added (`anvil-first.log`, `anvil-third.log`, `anvil-fourth.log`).
- Actual Safe creation exposed compiler-metadata differences between the factory's
  embedded SafeProxy and the standalone artifact (`anvil-second.log`). The proxy
  executable body is now checked, and full observed code hashes are retained.
- The reused-adapter negative fixture initially accepted inconsistent immutable
  copies (`adapter-before.log`, `adapter-repro-YFvcwF/summary.json`). This prompted
  explicit consistency and registered-proxy binding checks before final acceptance.

The original failures remain separate from final results; none is counted as a
passing case. Existing main-bundle size warnings are unchanged. No runtime source
or protocol changes require the broad Rust, protocol Anvil or Kurtosis matrix.

## Local deployment

Only the UI image is replaced, with the current operator Compose files retained
and an image-only overlay appended. Node, signer and monitor container IDs,
images and start times are compared before and after. The dashboard configuration
SHA-256 must remain
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.
The final UI image is
`sha256:b4b504999d83e7b9e7c941c6be2230bb782a0d8846eec1694b4997138d9d3326`,
selected by `.runtime/treasury-flexible-setup/ui-final.compose.yml` after all prior
operator overlays. [Deployment evidence](ui-deployment.json) confirms only the UI
was recreated and the runtime configuration stayed identical. The final served
main, treasury and deployment-artifact JS bytes equal the final local build;
their SHA-256 hashes are in [final sources](final-sources.json).

Use the [shared-network runbook](../../runbooks/treasury-shared-network.md) for
selection, owner approvals, pending-request recovery and the live rehearsal.
