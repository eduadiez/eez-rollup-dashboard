# Treasury approved-batch calldata fix — 2026-10-21

The budget deployment plus Safe configuration is 32,068 bytes (32,132 for the
2-of-2 fixture). The dashboard’s copied fee helper still enforced 12 KiB and
raised `Invalid calldata` before requesting a quote or opening the submission
prompt. Safe approval succeeds earlier because it signs the smaller Safe call.
The batch integration previously disabled fee quoting and missed this boundary.

The running node/signer image labels report source
`8d03af4f78cb1c2bde36a64cc1fa09d4af288950`, protocol
`abcf9d8ffc4e0ccb5df271fc19efdf9a7fb57774`. Exact-revision public SDK/server sources
specify 64 KiB decoded calldata and a 160 KiB serialized quote envelope. Read-only
live probing accepted the 65,536-byte input into pricing (then returned the
expected insufficient-funds option for the unfunded public address); 65,537 bytes
was rejected by the size parser. These are parser observations, not settlement.
Image labels are recorded provenance claims, not an independently verified CI
source-to-image attestation. The older operator checkout’s 12 KiB source is not
the deployed version.

`src/lib/fees/l2-fees.mjs` and its upstream tests now match that exact revision
byte-for-byte. The only SDK implementation change is the input-size bound.
Exact request hashes, transaction fields, fee limits and malformed-input checks
remain unchanged. Nothing is truncated and no unquoted fallback exists. Saved
setup data, Safe approvals, contracts and the seven-step plan do not change.
[Recovery guidance](../../runbooks/treasury-shared-network.md#recovery-and-configuration)
explains reloading the same origin and submitting the approved step again.

## Evidence

- Before the fix, both the upstream size regression and the actual grouped
  contract setup reproduced `Invalid calldata` through `TreasuryDeployment.prepare`.
- `npm test`: 318 passed, no failures/skips; includes both formats, 64 KiB and
  one byte over, malformed bytes and the existing exact binding vectors.
- `node tests/integration/treasury-deployment-batches.mjs`: 15 cases passed on
  owned Anvil with real Safe/contracts. Quoted steps now use the production fee
  helper and fixture quotes based on actual EVM gas estimates. Both formats
  execute the full 32 KiB budget batch with quoted fees; saved approvals survive
  reload and preparation without another signature. The first post-fix run hit
  a test-only hex-casing assertion; comparison now uses byte-equivalent hex and
  the same checks pass. Original diagnostics remain retained.
- `EEZ_UI_URL=http://127.0.0.1:8080/dashboard node tests/cross-chain-call-fees.cjs`:
  18 browser cases passed, including a 32,068-byte call through the served UI in
  both wallet formats. Wallet requests and pricing are intercepted; no live
  signatures or broadcasts. Isolated browser storage was used.
- Production TypeScript/Vite and Docker builds passed; the existing chunk-size
  warning remains. `git diff --check` passed.

Only the local UI was recreated using
`eez-rollup-ui:treasury-calldata-20261021`. Served HTML and application/treasury
assets matched the build. Runtime configuration and monitor/node/signer container
identities were unchanged. [Validation and deployment summary](validation.json)
and [source hashes](sources.json) identify the tested work on the existing dirty
dashboard checkout at `0d26cf24d2fa23de31021d1a508f137e24804efd`.

Logs and downloaded exact-revision sources are local-only under
`.runtime/treasury-calldata-20261021/`; Anvil runs are
`anvil-thB8kq` (baseline failure), `anvil-Hbu3cQ` (fixture casing failure) and
`anvil-NljhET` (pass) under `.runtime/treasury-deployment-batches/`. No shared-chain
transaction or native Composer/proof/follower replay was executed for this
SDK-only fix. Older servers may still reject large calls at their own bound.
