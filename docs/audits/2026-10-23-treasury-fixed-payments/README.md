# Fixed treasury payments — 2026-10-23

## Scope and identity

Remove percentage-of-holdings payments from the production contracts, signing
client, capability checks, UI and active rehearsal instructions. Retain the split
slider, both initiating Safes and recipient chains, live shared owners, 100/150
limits, internal Safe transfers, faucets, history and isolated invoice rollback.
This implements the [accepted scope](../../proposals/one-treasury-two-safes.md#accepted-fixed-payment-simplification-2026-10-23).

- Dashboard branch: `codex/treasury-demo-release`.
- Dashboard HEAD: `a96bc5cd3e7df91ac585ce7cdf6303f82fc7bfb6`, with prior uncommitted work preserved.
- Pinned core: `855fe0602484750861b4c31502a1a91355d33ed6`; no submodule edits.
- Safe: `bf943f80fec5ac647159d26161446ac5d716a294`.
- Safe modules: `c95f03900bff99be090dadb9de1c74b162365485`.
- New release: `ef44a9ce1e7823ab2e76549a3773ef68d5f1a483b866c74856dcaafabaaf51ac`.
- Previous release: `9b7548e5819f28db77942f4ae00401d38f6cdd8e35e08673e3261af8ca506178`.

No `.env`, network binding, public deployment, operator wallet or service restart
is part of this change. The runtime checkout is read by the existing isolated
launcher; verified executable copies, ports and datadirs belong to each run.

## Implementation and compatibility

`paySplit` retains its ABI and `SPLIT_VERSION = 2`. The immutable policy address
binds the asset. Production policies no longer expose either `payRule` selector,
its event, denominator, fraction errors or automatic allocation. `_pay` checks
the signed contribution before subtracting it, checks each Safe's capacity and
the global budget, then executes the existing bridge path. The invoice fixture
computes destination-first funding within test code before using that same path.

The UI retains percentages for the **funding split**, which divides a fixed
amount. It removes percentage-of-holdings selection, estimates and result
branches. Exact fixed, transfer and invoice intent shapes remain unchanged.
Removed rule intents fail validation, even with an old capability flag or added
amount; they cannot be converted into fixed payments. Retained artifacts and
browser journals are not rewritten. Existing policies keep their deployed code;
any pending percentage request requires its original release for reconciliation.

| Runtime bytecode | Previous | Current |
| --- | ---: | ---: |
| Chiado policy | 10,141 bytes | 5,983 bytes |
| Standard bridge policy | 8,412 bytes | 4,959 bytes |

Both policy runtimes shrink about 41%. Bootstrap, owner adapter and official
Safe/factory/batch-helper/allowance bytecode are unchanged. These measurements
are bytecode sizes, not measured gas or throughput claims.

## Validation

The focused baseline passed 47 JavaScript tests before edits. Current results:

| Check | Result |
| --- | --- |
| `npm test` | 440 passed; none failed or skipped |
| `forge test --root contracts` | 134 passed; none failed or skipped; includes split fuzzing |
| `npm run build` | Passed; existing import/chunk warnings remain |
| `npm run check:treasury-release` | 18 source/artifact pairs checked |
| Setup integration | 19 scenarios passed after correcting the obsolete size assumption below |
| Source publication integration | 6 real Anvil deployments; exact recompilation, nested discovery and worker restart passed; explorer transport is controlled |
| Native browser rehearsal | Passed; natural reset, fixed payments, both routes, owners, invoice rollback, history and mobile layouts; independent replay and posted attestation verified |
| Native standard-bridge rehearsal | Passed; both initiators/destinations, exact split, owner changes, lost-response browser recovery and later-leg USDC rollback; independent replay and posted attestation verified |

The removed percentage-only tests account for the lower test count. Retained
regressions cover both removed selectors, a signed amount unchanged after an
owner changes balances, exact split failures, later-leg rollback, stale intents,
mainnet configuration without rule capability, and the exact release ABI.

### Preserved first failure

The first setup integration failed at its assumption that the policy deployment
calldata must exceed 12,288 bytes. The smaller policy produces a smaller batch.
The corrected check requires the complete policy creation bytes, the unchanged
65,536-byte ceiling, exact Safe hash and byte-for-byte quote/submission matching.
Both transaction types remain covered; fee unit tests independently check input
sizes around 12 KiB and the 64 KiB boundary. The corrected setup run passed all
19 scenarios. This is a corrected assertion, not a retry-only flaky pass.

The correction to this standalone Anvil test was applied after the native runs
finished, keeping their source snapshots fixed. It is not executed by the native
rehearsals; their initial source manifests retain the pre-correction test hash.
The corrected script and its actual Anvil result are recorded separately.

## Evidence and limits

Detailed results, exact source/executable hashes and limitations are recorded in
[results.json](results.json). Both native runs passed on their first attempt; the
full browser run took 773 seconds, including its natural ten-minute budget reset. Full local evidence is under `.runtime/treasury-fixed-payments-20261023`
and the individual run directories. These ignored local files are not available
from another checkout. The release and compiler inputs are part of this change; no claim of a security audit or a live mainnet deployment is made.

The standard-bridge test uses the retained Ethereum bridge/USDC runtime snapshot
with fresh isolated state. It is not a fresh live fork or production acceptance.
Browser tests use real fixture signatures and RPCs through a test EIP-1193
provider, not real browser-extension dialogs or the official Safe application.


## Reproduce

Run from the dashboard root, with the pinned runtime checkout available:

```bash
npm test
forge test --root contracts
npm run build
npm run check:treasury-release
node tests/integration/treasury-deployment-batches.mjs
node tests/integration/treasury-source-verification.mjs
python3 scripts/run-treasury-integration.py --runtime ../rollupX --ui test
```

Executed native runs reused binaries from
`.runtime/treasury-integration/20261023T065350-er20ywi2` only after the launcher
verified exact runtime source and executable identities. Their results are:

- Browser: `.runtime/treasury-integration/20261023T071752-3wuebt7f`.
- Standard bridge: `.runtime/treasury-integration/20261023T072359-9qpxe94a`, with
  `--standard-bridge-snapshot .runtime/treasury-integration/20261022T223230-n4c03kfm/mainnet-snapshot.json`.

For a checkout without those local artifacts, use the normal build and snapshot
procedures in the [integration guide](../../../tests/integration/README.md) and
[mainnet runbook](../../runbooks/treasury-mainnet.md). Public source publication,
a new live fork and real wallet/Safe-app acceptance were not run in this change.
