# Treasury transition to the dashboard networks — 2026-10-20

**Implemented and available in the local dashboard:** wallet-approved shared
setup, initial 1-of-1 owner A, connected-wallet B selection and ordinary L1 Safe
owner administration. The target is Chiado 10200 / EEZ-X 906969, rollup 1.
The normal dashboard's RPC/Composer configuration is preserved.

**Not deployed on-chain:** A had zero test gas on both networks in the final
read-only check. No treasury application transaction was signed or broadcast
on the shared network. The 31-step wallet deployment, actual extension approval,
shared payment settlement and hosted Safe-app rehearsal remain unverified.
The dedicated asset is Test USDC, not Circle-issued USDC; limits are 100 per Safe
and 150 globally per ten-minute period. No Guard is installed.

## Source and network identity

Dashboard branch `feat/treasury-demo`, base
`0d26cf24d2fa23de31021d1a508f137e24804efd`, plus the application work in this tree.
Pinned dependencies are unchanged: core
`855fe0602484750861b4c31502a1a91355d33ed6`, Safe 1.4.1
`bf943f80fec5ac647159d26161446ac5d716a294`, AllowanceModule v1.0.0
`c95f03900bff99be090dadb9de1c74b162365485`. Their worktrees were clean.
Solidity settings and artifacts are documented in the [contract project](../../../contracts/README.md).

The shared node and proof-signer images advertise runtime revision
`de4209a5e956b432db7a7d37517d9d44d68dfaa4`, with exact source gitlink core
`f46af7c9833ac12a54f14d52f4da1f318a0f6525`. Observed image digests:

| Role | Digest |
| --- | --- |
| Node | `sha256:76f072e0af67cebcb5e3b031d9128ecfd2ae657ab2dbff6bb23f854c79ce29a7` |
| Signer | `sha256:012f151a6d1bdbdd5cc20cb4f1677fcc0b0dbb63b9a1b0189791eef9a97d16be` |

These are image-label and exact-source observations, not full CI-manifest
verification of source-to-binary provenance. The live UI therefore checks chain
references, proxy code, implementation slots and implementation code hashes.
The [original preflight](preflight.json) and [post-update preflight](preflight-after-ui.json)
retain the public addresses and hashes. The earlier report's `deployed: false`
field was subsequently clarified to `deploymentVerified: false`: the checker
does not discover all existing application deployments.

L1 block `0x168472e`, hash
`0x73ea7f8b13754ddb32ac174d2eb4bd3fc33d2d4b8d75c95133200e06c3deb5b2`,
matched the public Chiado RPC. Genesis reads on the connected L1 returned pruned
history, so the profile uses a retained finalized reference. L2 retains a genesis
reference. A missing/pruned reference fails validation; refreshing it requires
checking continuity and preserving any existing deployment journal.

The native integration uses runtime
`fa916b13254a36423cad130080dde367bb18a7d6` with preexisting local changes, core
`855fe06`, and full source-inventory SHA-256
`359f9056090bac43ef4a2efc1754dc9d9ff9480d3f257446070ed43153fac71d`.
It reuses exact verified executables from the previous run; it does not validate
the shared runtime image or its public-chain fee pricing. Foundry 1.7.1,
Solidity 0.8.34/0.7.6, Node 26.7.0, Playwright 1.63.0 and Rust 1.95.0 were used.

## Changes and boundaries

- The shared core forbids forwarded calls/static reads to the manager itself.
  Reproducing that restriction in the local delivery mock made the earlier
  40/110 payment test fail with Safe `GS013`. `TreasuryAliasReader` now performs
  alias derivation through a local L1 registry call. The helper has no custody,
  module power or mutable policy. Constructor argument 4 of TreasuryPolicy is
  now the helper address. The corrected regression explicitly rejects a remote
  manager read and proves the helper route; the final contract suite passes.
- `ConfiguredTreasuryBridge` initializes manager, local rollup and administrator
  during construction. An outsider cannot claim the legacy initializer between
  deployment and setup. A test verifies both that rejection and 150-token
  escrow-backed bridging. The public-counterpart administration and other
  inherited test-bridge limitations remain; this is not a production bridge.
- Shared configuration binds to the normal dashboard chains, endpoints and
  protocol implementations, uses bound Composer fee quotes, and rejects the
  isolated invoice-control endpoint. Private histories/configuration remain
  supported without pretending to be shared deployments.
- The initial Safe has only `0xcEAF908C05B277E92e89b51B281Ec76305b9A141` at
  threshold 1. A connected wallet supplies B's public address; current L1 owners
  authorize adding it. Tests cover thresholds 1 and 2, outsiders, stale nonces,
  invalid candidates and canonical completion. A review copies the old owner
  state so a later read cannot silently alter the signed preconditions.
- Browser setup packages 12 reviewed contract artifacts in a lazy chunk. Each
  of 31 transactions requires a wallet confirmation; Safe administration also
  uses typed-data approval. A saved pending request blocks retries, including
  after reload. Recovery checks exact sender/nonce/calldata/value and canonical
  receipt identity. Runtime bytes, immutable bindings, final funding and grants
  are checked before opening the live payment UI. Web Locks protect all setup
  journal writes from concurrent tabs.

The hosted Safe configuration service lists Chiado, but canonical Safe 1.4.1
singleton `0x41675C099F32341bf84BFc5382aF534df5C7461a` and factory
`0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` had no code there. Official
safe-deployments revision `e9cc9798ab834e7fe515d361566eb4a28c65387f` did not
list chain 10200 for those 1.4.1 artifacts. A newly deployed singleton is not
assumed to be indexed by the hosted app. The dashboard owner-change flow works
without that service; no unverified hosted Safe link is advertised.

## Validation and retained failures

| Check | Result / scope |
| --- | --- |
| `npm test` | 252 passed, zero skipped/failed; includes deployment recovery, owner addition, shared manifest and fee binding tests |
| `forge test --root contracts` | 55 passed, zero skipped/failed; delivery is mocked in Solidity tests |
| `npm run build` | TypeScript/Vite passed; existing main-bundle size warning remains |
| `npm run check:treasury-artifacts` | Generated ABI/bytecode/pin bundle matches Foundry outputs |
| `forge fmt --check --root contracts`; `git diff --check` | Passed |
| `node tests/treasury-shared-browser.mjs` | Passed against the deployed normal dashboard and real read RPCs; injected read-only wallet, no signatures/submissions |
| Existing preview browser regression | Passed hidden navigation, simulated budget flow and four responsive widths; all RPCs mocked and no sends |
| Final native browser regression | Run `20261020T171050-ni26jba1`: 1 selected native test passed in 572.08s, zero failures/ignored; outer source/executable verification passed |

The final [summary](summary.json) records the source and executable identities;
[scenario evidence](scenario.json) records successful canonical owner verification,
40 locally / 110 split to L1 / rejected 1, the natural budget reset, 10% paying 30,
and 110 to EEZ-X funded 100 locally plus 10 from L1. The independent follower
replays the successful outcomes. Controlled invoice inclusion failure proves
prior transfer execution and unchanged canonical balances/counters. History
retains four settlements, three preparation rejections and one verified rollback,
with zero automatic resubmissions. Application-source hashes match the frozen
final files. This is isolated native evidence with an injected signing provider;
it does not validate the new 31-step shared-wallet setup end to end.

Reproduce from this repository using the prerequisites in the
[integration runbook](../../../tests/integration/README.md):

```bash
npm run test:treasury:ui -- --runtime /home/edu/Development/rollupX --reuse-run .runtime/treasury-integration/20261020T154209-7sciw1sf
node tests/treasury-shared-browser.mjs
EEZ_UI_URL=http://127.0.0.1:8080/dashboard node tests/treasury-demo.cjs
```

The reuse directory is local-only; without it, omit `--reuse-run` to build and
record exact artifacts according to the integration runbook. Native logs,
traces, screenshots and datadirs are retained locally in the final run directory;
these bulk diagnostics are not committed. The two earlier failed runs remain
separate and are not relabeled as passes.

The read-only browser check verifies hidden direct URLs, shortcut reveal, both
network identities, 31-step setup, connected A, zero-gas disabling, reload and a
390px layout without horizontal overflow. [Browser result](shared-browser.json)
contains only public identities and method names. Screenshots/logs are local-only
under `.runtime/treasury-shared-network/`; they are unavailable to other checkouts.

Retained failures and corrections:

1. The owner-addition stale-state test initially failed because a review retained
   a mutable state reference. It now copies the preconditions. Original output:
   `.runtime/treasury-shared-network/unit-tests.log`.
2. Native run `20261020T165010-r33hjlwp` failed on the old
   `Switch to treasury devnet` selector after the button was renamed. The selector
   now follows `Switch to EEZ-X`. Logs/datadirs were retained.
3. Run `20261020T165525-ih4gd6kl` passed its native/browser semantic assertions
   in 896.87 seconds, but the outer runner failed its source-identity check
   because application files changed while it ran. This run is **not** accepted
   as final revision evidence. The subsequent run freezes application sources.
4. The first local Compose restarts kept the old pinned image, and the browser
   timed out waiting for the setup screen. The final operator overlay overrode
   `EEZ_UI_IMAGE`. The final update appends a treasury-owned image-only overlay;
   the corrected read-only browser check passes. Original browser logs remain.

The baseline remote-manager restriction failure was observed in terminal output;
a standalone baseline log was not retained. The compatibility source comparison
is local-only at `.runtime/treasury-shared-network/source-comparison/`.

## Local UI operation

The new UI image is
`sha256:31446c3ec7af59e54ea5720a82f2bf62068991d13a80f5c5e297649fb2d70a61`.
All prior Compose files, including their existing runtime/fee configuration,
were retained in order. The only appended overlay is local-only
`.runtime/treasury-shared-network/ui.compose.yml`, selecting that image.
A rendered-config comparison required the UI image to be the only change.
No operator `.env` file was edited. A later Compose command using only the old
file list can select the old UI again; retain the appended overlay to keep this
build. Do not infer the active image from `EEZ_UI_IMAGE` when a later overlay
sets a literal image.

The [deployment check](deployment-check.json) verifies replacement of only the
UI container. Node, signer and monitor identities/start times were unchanged.
Dashboard configuration SHA-256 remains
`d74e6c1f7d909f128efb55e1ce4d3fbd8d31131ef084da6253cf96e6ba9ada71`.
The new screen is available at [the local dashboard](http://127.0.0.1:8080/dashboard/)
after the existing keyboard shortcut. Existing private devnets and Safe-app
containers were preserved.

## Outstanding live acceptance

Fund A with test xDAI on Chiado and EEZ-X, then follow the
[shared-network runbook](../../runbooks/treasury-shared-network.md). The actual
wallet must approve deployment and the subsequent owner/payment actions. Do not
substitute operator posting/proof keys or the public private-devnet fixture keys.
No shared-chain receipt, fee-funded payment, human wallet-extension interaction,
31-step deployment completion or hosted Safe-app acceptance is claimed here.
Controlled inclusion rollback remains validated only in the isolated fixture;
there is no shared-network relay control or promise of deterministic public
inclusion ordering.
