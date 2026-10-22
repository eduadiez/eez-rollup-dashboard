# Treasury mainnet compatibility preparation — 2026-10-22

Status: configuration and USDC compatibility preparation implemented and checked.
This is not production deployment approval or a security audit. The production
bridge and full Ethereum-anchored EEZ rehearsal remain outstanding.

## Scope and identity

All changes are in `eez-rollup-dashboard`, on the existing `feat/treasury-demo`
branch at HEAD `0d26cf24d2fa23de31021d1a508f137e24804efd` plus the working tree.
Pre-existing changes and the current treasury were preserved. The exact affected
source hashes are in [source-sha256.json](source-sha256.json).

Pinned protocol: `855fe0602484750861b4c31502a1a91355d33ed6`; Safe:
`bf943f80fec5ac647159d26161446ac5d716a294`; Safe modules:
`c95f03900bff99be090dadb9de1c74b162365485`. Foundry 1.7.1,
commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`; Solidity 0.8.34 for integration
fixtures and the existing 0.7.6 Safe/module artifacts.

The implementation adds an explicit Ethereum manifest, canonical USDC identity,
proxy implementation checks, bridge origin/mint-authority checks, both source-chain
Composer checks, exact 100-per-Safe allowance configuration and manifest-bound
explorer links. It rejects packaged test bridges, including metadata-only variants.
The read-only CLI accepts no signer. Both payment initiation domains and the
150 shared budget are retained. The
[mainnet runbook](../../runbooks/treasury-mainnet.md) describes configuration and
release requirements; the [proposal](../../proposals/one-treasury-two-safes.md)
records the accepted preparation scope.

No new `.env` variables were retained. An initially proposed optional manifest-path
setting was removed at the user's request; the existing environment, runtime
`treasury` field and configuration files remain unchanged. The current live
networks were read as Chiado 10200 and EEZ-X 906969.

## Validation

[validation.json](validation.json) records the results and limitations.

| Check | Result |
| --- | --- |
| `npm test`, with a repository-local `TMPDIR` | 385 passed; zero failed/skipped |
| `forge test --root contracts` | 191 passed; zero failed/skipped |
| Explicit `FOUNDRY_PROFILE=mainnet` USDC fork suite | 4 passed; zero failed/skipped |
| `tests/treasury-view-browser.mjs` | 14 groups passed, including Ethereum links and existing Chiado flows |
| `tests/treasury-wallet-browser.mjs` | 11 groups passed |
| TypeScript/Vite and Docker builds | Passed; existing chunk-size advisory remains |
| Solidity formatting, CLI syntax, `git diff --check` | Passed |
| Incomplete mainnet manifest template | Rejected before RPC access, as intended |
| `check:treasury-artifacts` | Fails; baseline discrepancy described below |

The fork source was the user-supplied Tenderly Ethereum replica, chain 9991,
block 26082600, hash
`0x563344a123fccab81f91fc3d27419a21f90a34ed6f4dc186b30d5d7dbe6b679f`.
The local Foundry EVM used chain ID 1 for Ethereum Safe signatures. Funding came
from an existing USDC holder impersonated only in that local fork. Pause and
blacklist roles were likewise local-only. No transaction was sent to Tenderly or
Ethereum; the endpoint is not stored in this record or `.env`.

The four fork tests exercise actual USDC state/code with the pinned Safe and
AllowanceModule: fractional transfers through a contract delegate, the 100-USDC
ceiling, paused-token rejection, and a blacklisted second transfer rolling back
an earlier transfer and allowance consumption. They do not exercise an EEZ
execution table, proof, bridge or follower. Browser tests use controlled RPC and
wallet responses; they are not real-wallet acceptance tests.

Two newly added test expectations initially failed and were corrected: address
checksum comparison, and fixture detection across via-IR metadata layouts.
An early configuration test also hit the host `/tmp` quota; the suite completed
using its own temporary directory. These are retained failures, not ignored tests
or passing retries of unchanged failing code.

## Artifact discrepancy and preservation

The checked-in browser deployment bundle does not reproduce exactly from fresh
Foundry outputs. The failure also occurs in an isolated build using the pre-turn
`foundry.toml` and unchanged application/default-test sources, excluding the new
fork suite. `L1Owners` and `TreasuryOwnerAction` differ in compiler metadata;
comparison after removing metadata confirms identical creation/runtime executable
code. Other differing fields are raw Foundry artifact provenance hashes.

The existing browser bundle was not regenerated: changing metadata would change
runtime hashes and CREATE2 inputs used by already confirmed setup plans. Its bytes
remain unchanged. The new fork profile has separate output/cache directories.
Resolving the older artifact provenance discrepancy is still required before a
fresh production release; this work does not report that check as passing.

## Local rollout and retained evidence

The local UI image is `eez-rollup-ui:treasury-mainnet-20261022`. The rollout checks
runtime configuration and `.env` hashes before and after, the served treasury
assets against the validated build, and unchanged monitor/node/signer container
identities. No application or protocol contract deployment is part of this rollout.

Detailed logs, screenshots, baseline artifact comparison, fork observations and
rollout evidence are local-only under `.runtime/treasury-mainnet-20261022/`.
That ignored directory is not available in another checkout. This tracked record
retains the sanitized results and source hashes; no full native mainnet EEZ,
independent replay, Safe-app session or security audit was performed.

## Public mainnet deployment discovery — 2026-10-22 follow-up

The user's existing [mainnet dashboard](https://mainnet.eez.dev/dashboard/) closes
an earlier evidence gap: the prior checks only inspected the local Chiado target.
The public runtime configuration and RPCs were checked without signatures,
transactions or changes to either deployment. Sanitized results are retained in
[public-deployment-check.json](public-deployment-check.json).

- Ethereum RPC reports chain **1**; EEZ-X reports **696990**, with rollup ID **1**.
- Public configuration advertises core revision
  `855fe0602484750861b4c31502a1a91355d33ed6`, matching the dashboard's pin. This is
  advertised source identity, not independent runtime/proof verification.
- Both Composer fronts pass nonce-bound discovery against the configured chain,
  registry, manager and bridge identities.
- Existing bridge addresses are Ethereum
  `0x1d6a3bfe0a302bb2df5fdfdb8eaf5b78b91a5fba` and EEZ-X
  `0xBEF1406984A3e7b2889376d29D6BbD9f6ed9695a`. Both return the expected manager,
  rollup IDs and counterpart addresses. Both runtime hashes are
  `0xf1c7221a57ab87e4bcc478feae7ffddd84952880e8fea4574ab1218416b28dab`.
- EEZ-X already has USDC representation
  `0x787f00f5e0f0b9C8CC4e5E31d3c8a7Db83159dd9`, with six decimals, Ethereum USDC
  as its origin at rollup 0, and the configured EEZ-X bridge as mint authority.
  This checks its identity and authority; it does not prove backing or security.

There is consequently no need to request another network's addresses or add
`.env` variables just to identify the mainnet infrastructure. This evidence does
not yet make the existing treasury a drop-in deployment there: calls to the
current treasury integration's `canonicalToken()` and `treasuryRollupId()` getters
revert on both deployed bridges. Integration must adapt to the existing bridge's
reviewed interface, or use an explicitly reviewed compatible implementation; do
not silently skip these checks or assume bridge equivalence from its address.
The public configuration supplies no treasury manifest with Safe/policy bindings.

The deployed bridge runtime is different from the local pinned test Bridge
artifact, even with compiler metadata stripped. Therefore this check neither
labels the deployed bridges as those exact test fixtures nor establishes their
source provenance or production suitability. Those need separate review.
Bridge snapshots were Ethereum block **26248710** and EEZ-X block **743954**;
token-origin checks used EEZ-X block **743986**. Block hashes were rechecked after
the reads. Raw responses are local-only under
`.runtime/treasury-mainnet-site-20261022/`.

Artifact reconciliation, a complete treasury rehearsal against this target, and
independent security review remain outstanding. No chain service, wallet,
configuration or application code was changed during this discovery.


## Standard bridge integration and selected-Safe setup — 2026-10-22 follow-up

This follow-up implements the integration identified as missing above. It keeps
all application, fixtures, scripts and records in `eez-rollup-dashboard`, on the
existing `feat/treasury-demo` checkout (base
`0d26cf24d2fa23de31021d1a508f137e24804efd`). Core remains pinned to
`855fe0602484750861b4c31502a1a91355d33ed6`. The native harness reused verified
runtime binaries from `20261021T205237-nrg23lqe`, at runtime checkout HEAD
`fa916b13254a36423cad130080dde367bb18a7d6`, including its unchanged recorded working
source inventory. No runtime or protocol changes were made.

### Resulting behavior

`StandardBridgeTreasuryPolicy` uses the deployed generic bridge API. Ethereum's
Safe grants the official allowance module's bounded 100-USDC delegation to
`StandardBridgeDelegate`, then binds it once to the policy alias. The delegate
accepts calls only from that alias, executes local allowance/approval/bridge work
in one Ethereum call, and checks the final balance and consumed approval.
EEZ-X grants its 100-USDC allowance to the policy. The global limit remains 150.
Neither new contract receives unrestricted Safe module authority.

Both signing domains, both destinations, exact splits and percentage rules are
supported. Mirror signatures still bind the EEZ-X Safe/domain/nonce, while its
submission goes through its Ethereum alias. The UI explains this switch and
links Ethereum transfer/owner verification to the actual source transaction,
not to the separate queued-entry posting transaction.

Users enter their existing Ethereum Safe in the dashboard. The selected wallet
deploys application contracts; the Safe quorum authorizes both spending limits.
The six-step planner reuses verified Safe infrastructure and the existing
bridge/USDC, with no token deployment, minting, or automatic funding. Existing
mirrors must already be connected to the selected Ethereum Safe. Mainnet setup
uses separate storage keys and `mainnet-artifacts.json`; it does not rewrite the
frozen Chiado artifacts. The optional operator manifest import remains supported.

### Native failure investigation

Several earlier candidate call shapes failed during native composition despite
passing ordinary EVM tests. A retained diagnostic trace at
`20261022T154732-9x5f05mn`, transaction
`0x57880d08ff67083a366497e3089718e816f4b3ba9ee4b82bcd2cdec21605d91d`,
observed the policy alias holding **5,000,000** USDC base units after it had spent
that balance; the expected residual was zero. The residual check reverted.
The behavior is consistent with stale cross-chain post-call snapshots in the
current Composer/interpreter boundary. This is an application-path diagnosis,
not a completed runtime audit or protocol fix. No check was removed or bypassed.

The final delegate consolidates all mutable Ethereum funding operations into one
callback. Earlier executor, outer-batch and diagnostic prototypes were moved,
with SHA-256 hashes, into the ignored local evidence directory; they are not
shipping contracts. Earlier failed runs retain logs/datadirs. Additional harness
failures included missing RPC forwarding, a diagnostic constant compile error,
browser CORS/teardown handling, and percentage-versus-basis-point slider input.
These were corrected with targeted checks, not ignored or retried as successes.

### Verification and limits

The first full passing native run is `20261022T161801-fg69_f9o`. It uses byte-for-byte
copies of the captured deployed bridge, USDC proxy and USDC implementation runtime
with **fresh isolated state and fixture roles**, plus the real native Composer,
proof signer and independent follower. It is not a fork of the live EEZ database.
It verifies:

- Add/remove an Ethereum Safe owner and accept the newly added owner's genuine signature.
- Pay 40 on EEZ-X, then 110 to Ethereum funded by 100 + 10; reject another 1 while EEZ-X retains 50 of allowance.
- Initiate from either Safe and deliver to either chain, with exact 5 + 5 funding and independent balance/counter/replay assertions.
- Pay 10% of execution-time combined balances.
- Browser EIP-712 approvals, switch to Ethereum for mirror submission, real broadcast, lost wallet response, reload recovery, single submission and payment history.
- At inclusion, execute an earlier bridge release, then fail the second USDC transfer using the real token's blacklist behavior. The original proof/blob commitments stay unchanged. The source transaction reverts; both recipient balances, both Safe balances, both allowance counters, global budget, Safe nonces and bridge accounting remain unchanged. The posting transaction succeeds; no unconditional `L2TxSkipped` claim is made.

The browser replaces the extension shell with a test EIP-1193 provider; signatures,
RPCs, transactions and receipts are real in the isolated devnet. It does not
certify Rabby/MetaMask or a live Safe-app session. The public setup's six wallet
transactions have not been broadcast to Ethereum. Its chooser, address selection,
batch contents/size, journal isolation and transaction-replacement handling have
browser/unit checks. The same policy/delegate deployment and configuration are
executed by the native fixture, using its scripted deployment path.

The separate actual-Ethereum USDC fork suite passed all four tests at captured
Ethereum block **26248855**. It uses real USDC storage and local-only holder/role
impersonation. It covers ordinary ERC-20 transfers, module ceiling, pause, and
blacklisted-second-transfer rollback; it does not provide native EEZ replay.

Final unit checks: **400 JavaScript tests**, **204 Solidity tests**, **4 real-USDC
fork tests**, TypeScript/Vite, the new mainnet artifact check, and chooser browser
check passed. Existing frontend chunk-size warnings remain. The older frozen
Chiado artifact reproducibility discrepancy described above remains; its bundle
was intentionally preserved, not reported as regenerated successfully.

The public network setup validator passed read-only checks of chain/checkpoint,
protocol implementation, bridge code/peer/rollup, USDC implementation and origin,
wrapped-token mint authority, pause state and both Composer endpoints. This
establishes compatibility/identity, not an independent security audit. Production
readiness still needs that review and a real-wallet/public-Safe-app acceptance run.
No public-chain deployment, funding, mint or payment was broadcast.

### Preservation and local UI rollout

`.env`, `shared-network.json` and the frozen `deployment-artifacts.json` retain
their pre-task SHA-256 hashes. All existing Chiado contracts, balances and browser
journals are preserved. The local UI image is
`eez-rollup-ui:treasury-standard-bridge-20261022`; its runtime configuration is
byte-identical before/after, and monitor, node and signer container identities
and start times are unchanged. Its served treasury bundle matches the validated
build. This is a local frontend rollout, not publication to mainnet.eez.dev.

Detailed local-only logs, native failures, screenshots, runtime snapshot,
prototype archive and rollout checks are under
`.runtime/treasury-mainnet-bridge-20261022/` and the named native run directories.
The durable snapshot is [standard-bridge-snapshot.json](standard-bridge-snapshot.json).

The final rerun, **`20261022T162532-6x12i0y9`**, also passed after prototype
cleanup and correction of the Ethereum execution links, with the final source
inventory including the selected-Safe setup. See
[standard-bridge-rehearsal.json](standard-bridge-rehearsal.json) and
[standard-bridge-source-sha256.json](standard-bridge-source-sha256.json). All eight
scripted payment/rejection records, browser recovery, canonical inclusion rollback,
attestation and independent follower replay passed. No intended test was skipped.
The running local UI is healthy and its served treasury asset exactly matches the
validated build. The mainnet chooser browser check used only controlled form
submission; the mainnet network validation was read-only.
