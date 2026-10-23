# Treasury faucet recovery and internal Safe transfers

Date: 2026-10-22. Status: implemented, validated and deployed to the local dashboard.

## Scope and source identity

Changes are confined to `eez-rollup-dashboard`, branch `feat/treasury-demo`, on
`0d26cf24d2fa23de31021d1a508f137e24804efd` plus existing and current uncommitted
work. Core pin: `855fe0602484750861b4c31502a1a91355d33ed6`; Safe pin:
`bf943f80fec5ac647159d26161446ac5d716a294`; Safe modules:
`c95f03900bff99be090dadb9de1c74b162365485`. No Solidity, protocol pin or frozen
deployment-artifact changes are part of this fix. Safes, bridges, token, policy,
operator configuration and browser journals are preserved.

The configured live node is image digest
`sha256:c8725a8da26888b51d455daade29a894228da8ca9eae2226e85d6a82c731dd95`,
with OCI revision `8d03af4f78cb1c2bde36a64cc1fa09d4af288950`. The separate local
rollupX checkout is at `fa916b13254a36423cad130080dde367bb18a7d6`; its fee source
is not treated as the implementation of that running image.

## Findings and changes

The faucet inherited setup's prerequisite that every completed historical
transaction still have an accessible canonical receipt. A regression reproduces
the reported “Recheck Prepare the test-token faucet” error with that prerequisite.
Independent new faucet requests now verify current dispenser/token/bridge bindings
without replaying all completed receipts. Pending requests still block new work
until their existing exact transaction reconciliation succeeds. The user's exact
missing receipt was unavailable; their browser journal was not inspected or
rewritten. The current public dispenser deployment receipt was available during
this investigation, so the precise RPC failure affecting their old request is
not established.

The existing TreasuryPolicy explicitly disallows either treasury Safe as a
payment recipient. A read-only quote to the mirror reproduced
`unsupported_transaction` with “gas estimation or final effect validation failed”.
The UI now rejects that merchant-payment route before signatures and offers an
explicit **Move to EEZ-X Safe** operation. Owners authorize the Chiado Safe's
verified official MultiSendCallOnly helper to reset approval, approve the exact
amount, bridge it to the mirror and clear approval. It uses existing contracts
and source owner authority. It does not debit the merchant payment allowances
or shared budget; this is disclosed before approval. Reverse internal transfers
are outside this change. Policy payments retain both directions and their limits.

Tracking checks the exact source Safe transaction and execution hash, token lock,
unique protocol call, destination mint and canonical inclusion. Reorgs, missing
or ambiguous evidence cannot release pending work as successful. The new intent
uses the existing journal/history mechanism. Older builds do not understand
pending `transfer` intents; keep this UI until they resolve.

Simulation is removed. Get Test USDC is shown only for a configured Chiado testnet
treasury. No new environment settings or automatic funding were introduced.

## Validation

Run from the dashboard root:

- `npm test`: **391 passed**, zero failed, skipped or cancelled.
- `npm run build`: passed TypeScript and production build; existing chunk-size
  advisory remains.
- `node tests/treasury-wallet-browser.mjs`: **12 groups passed**, including review,
  Chiado wallet switching and approval/preparation of the full-balance transfer.
- `node tests/treasury-view-browser.mjs`: **15 groups passed**, including source,
  bridge and destination completion flow, history links and mobile layout.
- `node tests/treasury-faucet-browser.mjs`: **7 groups passed**.
- `EEZ_UI_URL=http://127.0.0.1:18083/dashboard node tests/treasury-demo.cjs` against
  the production preview: hidden navigation/session/deep-link checks passed;
  Simulation and the faucet are absent in the unconfigured non-Chiado fixture.
- `git diff --check`: passed.

Browser fixtures use real React and controlled RPC/wallet responses, not a real
wallet broadcast. Transfer unit tests use an actual EOA typed-data signature,
exact Safe call/fee bindings and canonical/reorg/ambiguous receipt fixtures. The
helper bytecode fixture matches the official runtime hash. Current-code validation
and pending locks remain tested for the faucet.

Read-only live validation used the existing Chiado Safe
`0x1a9925C1DA8d3754248844B84066824bC84306c1` and its current mirror
`0x46Ec46704cAB3979dA9e64f258c2B4AB907cC58E`. The **427.74 USDC** transfer received
valid bound fee quotes for legacy and type-2 transactions, gas `0x3df58`. These
probes use Safe's approved-hash simulation with an owner as caller; actual EOA
signature packing is covered separately by the unit/browser checks. No signature
was requested from the user's wallet and no transaction was broadcast.

Protocol-call correlation and mint tracking were additionally exercised against
an existing real faucet bridge delivery, source transaction
`0x921f5fcdea8a84c04937204ecdbf6f69c7a9140b9876da346af60d44432585e7`,
Chiado block `23637641`, EEZ-X block `1270290`, destination transaction
`0x551baee58716f574c12c76fae2faf32b518a27609c6b90ff6184c8c11d529dfd`.
That historical fixture validates bridge correlation, not a source Safe signature;
source Safe verification is tested independently. This does not establish an
end-to-end broadcast of the new transfer from the user's treasury.

Initial diagnostic failures are retained locally: a partial-config test fixture
exposed an undefined address guard, an invoice test used a now-disallowed treasury
recipient, and a typed RPC helper rejected an ABI outside its fixed union. These
were corrected and the final suites passed. Diagnostic live probes initially used
an older policy ABI and an out-of-retention state bound; neither probe sent a
transaction. Successful final probes are separate from those failures.

Local-only evidence is in `.runtime/treasury-recovery-20261022/`, including source
hashes, first failures, final suite logs, screenshots and `live-validation.json`.
It is ignored and unavailable in another checkout. The repository tests and public
transaction identities above provide the repeatable checks. No Solidity rebuild,
new isolated process suite, independent follower replay, real mainnet transfer or
user-wallet end-to-end broadcast was run in this task.

See the [shared-network runbook](../../runbooks/treasury-shared-network.md#moving-funds-to-the-mirror-safe)
for operation and the [accepted scope](../../proposals/one-treasury-two-safes.md#accepted-internal-transfer-and-faucet-recovery-2026-10-22).

## UI-only deployment

Built and deployed `eez-rollup-ui:treasury-recovery-20261022` using the existing
Dockerfile and Compose project. The deployment guard compared rendered Compose
configuration and allowed only the UI image change. `up --no-deps --no-build
--pull never ui` replaced that service. Health, the served treasury JavaScript/CSS
against the validated build, unchanged runtime configuration and unchanged `.env`
were checked. Node, signer and monitor container identities remained unchanged.
No application contract deployment, wallet transaction or network restart occurred.
The test preview was stopped after validation.

Deployed image ID: `sha256:5776ceeb33f0986eb992b5ec0bef99d751328a945a0216ea71330da75d489137`.
The saved deployment report is local-only
`.runtime/treasury-recovery-20261022/deployment.json`.
