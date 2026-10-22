# Treasury deployment batches — 2026-10-20

The user authorized grouping contract deployments while retaining their confirmed
Safe implementation. The new/new plan normally has six total transactions:
**five remain**, plus two Safe typed-data approvals for a 1-of-1 owner. On the
checked shared network, wallet A needs **seven remaining transactions**, eight
including its retained confirmation: two required proxy calls avoid occupied
CREATE addresses before the EEZ-X deployment batch. Wallet network-switch prompts are
separate. Existing Safes retain their quorum; an EEZ-X Safe needing owner adoption
adds one transaction and its current owners' signatures.

All implementation, tests and records are in `eez-rollup-dashboard`, branch
`feat/treasury-demo`, preserving existing work at HEAD
`0d26cf24d2fa23de31021d1a508f137e24804efd`. No protocol, operator environment or
wallet credentials were changed. The user's original confirmation is reported
by the user; we did not read their browser journal or independently inspect its
transaction hash. Retention is tested with a real receipt on an owned Anvil and
an isolated synthetic browser journal. No shared-chain transaction was broadcast.

## Design and identities

[Source hashes](sources.json) identify the final application and tests. Safe,
allowance and core pins are unchanged from the
[previous increment](../2026-10-20-treasury-simplified-setup/README.md): core
`855fe0602484750861b4c31502a1a91355d33ed6`, Safe
`bf943f80fec5ac647159d26161446ac5d716a294`, allowances
`c95f03900bff99be090dadb9de1c74b162365485`. Foundry 1.7.1 and Solidity
0.8.34/runs 1/via IR are used; legacy Safe compiler settings remain unchanged.

`TreasuryBootstrap` groups CREATE and zero-value CALL actions. It has an immutable
wallet owner, sequence check, reentrancy lock and permanent close flag. It never
owns a Safe, becomes a Safe module, or performs delegatecall. Created addresses,
return hashes and all call outcomes are required; a failure reverts prior actions.
New Safes are created and initialized within the same transaction. An official
factory is reused on Chiado and the confirmed 1.4.1 singleton is retained.

The L1 executor holds 150 freshly created test tokens between its first and final
batch. Its wallet controls that temporary custody. `BootstrapTreasuryBridge`
permits returning bridge administration from the executor to the wallet, while
leaving the legacy bridge artifact unchanged for pending-journal recovery. The
final checks establish both executors closed, both admins handed back, zero
executor token balance/approval, and no executor Safe authority.

Version 4 archives the raw previous journal before replacement, freezes its
completed prefix, and retains addresses, transaction hashes, salt and wallet.
Pending requests and reviews defer migration. Old setups which already created
their wallet-owned test token keep the previous plan. Whole-batch requests are
stored before the wallet opens; exact canonical transactions, creation/success
events, expected code and executor state are required before recording outputs.
No automatic retry is introduced. Older builds cannot resume version 4.

## Checks and measured batches

| Check | Result / scope |
| --- | --- |
| `npm test` | 272 passed; zero failed or skipped. Includes all eligible legacy prefix boundaries, version-3 backup and pending/review preservation. |
| `forge test --root contracts` | 61 passed; zero failed or skipped. Includes earlier CREATE/call rollback, owner/sequence checks, permanent closure, false return rejection, address mismatch and owner callback reentrancy. |
| `node tests/integration/treasury-deployment-batches.mjs` | Passed; [record](batches.json). All five phases execute real contracts on one owned Anvil with read-through EEZ managers and chain-ID changes per phase. Real receipts recover across reload; tampered action hashes and missing outputs are rejected. Existing 2-of-2 Safes complete the flow with current-quorum adoption/configuration and two injected occupied wallet CREATE addresses; both proxy preparation transactions execute. No Composer or proof validation in this test. |
| `node tests/integration/treasury-setup.mjs` | Nine compatibility cases passed on two owned Anvils; [record](legacy-setup.json). Retained version-2/3 flow, official factory, existing 2-of-3 owners and configuration/adoption rollback. |
| Installed browser | Passed; [record](browser.json). Six-step plan, confirmed-first-step migration to 1/6, exact backup, unchanged pending old request, hidden shortcut, selected wallet, existing-Safe controls and 390px layout. A separate [wallet-A browser check](browser-collision.json) reads actual shared nonce/code, shows 1/8 with seven remaining, and preserves its synthetic confirmed journal. Real read-only network requests; no wallet extension signing or submission. |
| Build / generated artifacts | TypeScript/Vite build and artifact check passed. Existing large-chunk warnings remain; deployment artifacts are lazy-loaded. |
| Native Composer/signer/browser rehearsal | Latest run passed all nine cases with independent follower replay; [source/executable identity](native-summary.json), [scenario assertions](native-scenario.json). Grouped bridge funding and L2 module/policy creation + signed configuration settled. **Overall retry history is flaky (`flaky-result = fail`)** due to the earlier browser transport failure; [run record](native-runs.json). |

The new/new grouped EVM test measured these transaction inputs and gas. These
are isolated-EVM measurements, not shared-network gas quotes:

| Phase | Input bytes | Gas used |
| --- | ---: | ---: |
| Chiado contract creation | 36,449 | 7,422,571 |
| EEZ-X contract creation | 47,361 | 9,934,538 |
| Bridge funding | 1,572 | 1,953,852 |
| EEZ-X policy creation + Safe configuration | 32,068 | 7,139,476 |
| Chiado Safe configuration | 1,252 | 546,408 |

Both creation transactions fit the 49,152-byte creation-input bound. Read-only
shared-network blocks reported gas limits of 17,000,000 (L1) and 30,000,000 (L2);
[block references](block-limits.json). The dashboard still obtains current gas
estimates or Composer fee quotes before requesting a transaction; these measured
values do not override network admission rules.

## Shared-wallet creation collisions

Read-only checks found wallet A (`0xcEAF908C05B277E92e89b51B281Ec76305b9A141`)
at pending/latest nonce 0. Its nonce-0 CREATE address
`0x4C3D971b1079E58843D0E1af155A2e54b9E54dbA` contains protocol implementation
code; nonce 1 maps to the protocol manager at
`0x4B2760F84B83d6b3829E30A7573B0172B6d6402C`. Nonce 2 is available. See the
[sanitized code/nonce check](creation-address-check.json). Ordinary Safe and
MultiSend deployments also return `CreateCollision`; this affects individual
creation transactions as well as batches.

The planner now inserts two required manager calls for the Safe and bridge
proxies. They consume the two wallet nonces with normal wallet approvals and
retain all previously confirmed outputs. No contract or nonce is replaced.
The original version-4 journal is archived before inserting these calls.
A live-node estimate with an **ephemeral nonce-2 state override**, synthetic
remote addresses and the original largest creation batch succeeded at
**10,031,066 gas**; [simulation evidence](shared-l2-estimate-after-preparation.json).
The override was used only for read-only estimation. It did not change shared
state, deploy contracts, or establish full shared-network execution. The actual
prepared plan omits the Safe proxy call already performed during preparation.

## Retained failures and corrections

The first EVM fixture call passed an encoded string to `anvil_setChainId`; Anvil
requires a numeric u64. The fixture was corrected before it exercised deployment.
The next run created its L2 Safe but correctly refused receipt reconciliation:
the factory embeds different Solidity 0.7.6 CBOR metadata than the standalone
proxy artifact. CREATE2 includes those bytes, so its address prediction was wrong.
The artifact generator now extracts the factory's unique embedded creation
literal, accepting differences only in the exact metadata span. The integration
checks that literal against the deployed factory getter, and the same five-phase
check passes. Failed receipts remain under the local run directory.

The first native run, `20261020T212507-f1phaywr`, stopped after a successful
executor deployment because a newly added test compared a lowercase RPC address
with a checksummed prediction. Its logs/datadirs are retained. The assertion now
normalizes addresses before comparison. This was a deterministic fixture failure,
not a retry-only semantic pass.

The second native run, `20261020T212800-1de1exb_`, settled grouped funding and
policy creation/configuration. Owner changes, invoice rollback, preparation
rejection, 40-USDC local payment, 110-USDC split and global-budget rejection passed.
After waiting for the next natural budget period, the browser's rule review
reported `Failed to fetch`; its preview locator timed out. Logs, screenshot and
datadirs are retained. The exact failed request was not captured in that run.
Request/console diagnostics were added without relaxing assertions or adding
retries. The next full run, `20261020T214323-i3_i1id1`, passed in 421.87 seconds,
including the rule, reverse payment, history and independent follower replay.
No transport fix was made, so the overall browser rehearsal remains a retry-only
pass with an unresolved flake (`flaky-result = fail`); the original failure is
not discarded. The first checksum assertion failure is recorded separately.

The native scenario uses real Composer, signer, L1 settlement and independent
follower binaries, verified against the successful artifact source
`20261020T204749-57y6wz2v`. It groups L1 funding (475,131 gas) and L2 module/policy
creation with signed Safe configuration (7,432,126 gas), within the native
fixture's existing 8M cap. Its Safe/bridge fixture setup is separate; the complete
five-phase UI deployment planner is covered by the owned-EVM test above. Wallet
signatures use a test EIP-1193 provider with public fixture keys, not a real browser
extension or the user's key.

## Installed UI and limits

The local UI image was updated through an image-only overlay at
`.runtime/treasury-deployment-batches/ui.compose.yml`. The full Compose comparison
allowed only `services.ui.image` to differ. Node, signer and monitor container
IDs/images/start times and runtime configuration remained unchanged. Three served
JS bundles match the built bytes; see [deployment evidence](ui-deployment.json).
Desktop/mobile screenshots were inspected. Refresh the same browser origin and
keep its storage to continue the saved deployment.

The complete shared-network wallet deployment and payment rehearsal remain for
the user. Native tests use the local core pin; the shared network has the distinct
verified profile described in the [network audit](../2026-10-20-treasury-shared-network/README.md).
No claim is made that the user's actual transaction was inspected or that the
shared treasury has finished deploying. Mainnet is not enabled by this change.

Small JSON evidence is retained here; bulk logs, screenshots, contract receipts
and datadirs are local-only under `.runtime/treasury-deployment-batches/` and the
referenced native run directories. See the [proposal](../../proposals/one-treasury-two-safes.md)
and [runbook](../../runbooks/treasury-shared-network.md).
