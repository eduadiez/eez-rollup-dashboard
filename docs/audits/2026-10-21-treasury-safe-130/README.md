# Safe 1.3.0 and 1.3.0+L2 treasury compatibility

Existing Safe imports now accept the official EVM 1.3.0 implementations, including
GnosisSafeL2 (shown as **1.3.0+L2** in the Safe app). Newly deployed mirror Safes
remain 1.4.1. Proxy validation, exact singleton identity, current owner quorum,
Guard rejection, owner-adapter bindings and canonical receipt checks remain in
place. No Safe, asset, bridge or deployed policy needs replacement for version
compatibility alone.

The [accepted increment](../../proposals/one-treasury-two-safes.md#accepted-safe-130-import-compatibility-2026-10-21)
and [reuse procedure](../../runbooks/treasury-shared-network.md#reusing-safe-130l2)
define the scope. The shared decoder accepts complete 1.3.0 non-indexed and 1.4.1
indexed execution-result logs. Setup, owner changes, both payment initiation
paths and lost-wallet-response recovery match the expected emitting Safe and
signed hash before the existing transaction and settlement checks.

## Provenance

- Dashboard baseline: `0d26cf24d2fa23de31021d1a508f137e24804efd`, with the existing
  treasury work preserved. Changed source identities are recorded in `evidence.json`.
- Native runtime: `fa916b13254a36423cad130080dde367bb18a7d6`; core protocol:
  `855fe0602484750861b4c31502a1a91355d33ed6`. No runtime or protocol changes.
- Official deployment registry: `e9cc9798ab834e7fe515d361566eb4a28c65387f`,
  [GnosisSafe](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.3.0/gnosis_safe.json)
  and [GnosisSafeL2](https://github.com/safe-global/safe-deployments/blob/e9cc9798ab834e7fe515d361566eb4a28c65387f/src/assets/v1.3.0/gnosis_safe_l2.json).
- Test bytecode/ABI: `@gnosis.pm/safe-contracts@1.3.0`; package SHA-512 integrity
  was verified before extracting the two artifacts. The committed
  [fixture](../../../tests/fixtures/safe-130-runtime.json) records that integrity,
  package source and runtime hashes. Both match the pinned registry and the
  actual canonical singleton code read from Chiado. Tests assert these hashes.

## Validation

The original import rejection was reproduced using the official 1.3.0+L2 runtime
on owned Anvils (`anvil-XKzYnY`): `Unsupported Safe implementation` at
`inspectSafe`. The same setup test passes after the change (`anvil-USTYDs`).
The default 1.4.1 scenario also passes (`anvil-uAyoSK`). These cases exercise
actual owner signatures, atomic owner adoption, preserved funds/modules/handler,
stale approvals, rollback, alias provisioning and allowance configuration.
Protocol discovery is mocked in these setup tests; they do not prove EEZ settlement.

343 JavaScript tests passed with none skipped. Regressions cover verified and
modified singleton code, version/code disagreement, both exact event layouts,
malformed logs, mixed-version manifest validation, canonical tracking, and lost
wallet responses for payments and owner changes. The first focused run caught a
missing `runtimeMatches` method in the new unit-test stub (74 passed, 2 failed).
The stub was corrected; no production validation was weakened.

The production TypeScript/Vite build and Python runner syntax checks pass.
The build retains its existing bundle-size advisory. No Solidity source changes
were needed; application artifacts and runtime binaries retain their existing
pins. Full isolated cross-chain/browser validation and local UI rollout pass, as
recorded below.

The local UI-only rollout passed its image/configuration checks, and a focused
read-only browser check imported the official 1.3.0+L2 fixture, retained its owners
and address, and resumed after reload at 1440px and 390px. Its mocked contract
observations and isolated browser storage do not establish a public transaction.
A broader read-only smoke first aborted in Playwright request routing
(`Route is already handled!`) while changing unrelated history fixtures. That
run is retained as failed, not counted as coverage or a retry-only pass. The
focused import check avoids those unrelated route changes and drains request
handlers before closing its browser.

The first full native/browser attempt (`20261021T164832-v97dbemy`) completed
all owner/payment/history assertions, the invoice rollback, the 10% rule, reverse
payment and L1-origin payment with independent follower replay through block
720. It then exited unsuccessfully because browser shutdown disposed the request
context while an RPC route callback was active. The overall run remains failed;
its retained datadir and logs are not presented as a passing native test. Browser
cleanup now awaits route-handler completion before disposing the context, and a
fresh complete run checks that fix. No signing or settlement checks were skipped.

The corrected full run (`20261021T170134-zaqf3_0g`) passed: one native test,
zero failures/skips. It repeated the real wallet-signature, owner-change,
40/110/shared-cap, invoice rollback, 10% rule, reverse-payment, payment-history
and L1-initiated-payment browser scenarios, then shut down cleanly. The harness
independently verified the posted attestation and follower convergence through
block 535 (`0x274766b59f3a8883e1032738bd71fc255c5b7a291e1d98d311ea56e2cee809e4`).
Both singleton contracts use the official 1.3.0+L2 runtime. Earlier 1.4.1 setup
and mixed-version client regressions remain passing.

Only the local UI container was replaced. Runtime configuration, monitor, node
and signer container identities were checked unchanged. Served JavaScript/CSS
bytes match the final build. No public Safe transaction, funding or deployment
was signed or submitted, and the user's browser storage was not modified.

## Reproduction and limits

From the dashboard repository root:

```bash
npm test
EEZ_TEST_SAFE_VERSION=1.3.0 npm run test:treasury:setup
npm run test:treasury:setup
npm run test:treasury:integration -- --runtime /path/to/rollupX --safe-version 1.3.0 --ui test
npm run build
```

Native artifact reuse follows the exact-identity checks in the
[integration guide](../../../tests/integration/README.md). It is not an override
for stale binaries. Local evidence under `.runtime/` is ignored and unavailable
in another checkout; `evidence.json` retains small sanitized identities/results.
Public-chain contract reads establish the observed code identity only. They do
not establish execution using the user's wallet or a hosted Safe-app rehearsal.
Existing treasury storage and signed requests are preserved. An older UI build
cannot operate a newly imported 1.3.0 treasury; retain the compatible frontend.
