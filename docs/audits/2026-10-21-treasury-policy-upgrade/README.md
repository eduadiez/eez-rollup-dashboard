# Existing treasury: payments initiated by either Safe

The connected treasury now has a policy-only upgrade. Existing Safe addresses,
owner adapter, module deployments, token, bridge, balances, setup journal and
history stay in place. The selected wallet deploys the inactive replacement;
each Safe authorizes its delegate handover. Activation verifies both old grants
are zero and carries live global and per-chain spending into the new policy.
Normal periods resume without the carried offset after the activation period.

The accepted scope and invariants are in the
[proposal](../../proposals/one-treasury-two-safes.md#existing-treasury-policy-handover-accepted-scope-2026-10-21).
The [runbook](../../runbooks/treasury-shared-network.md#enable-either-safe-on-an-existing-treasury)
contains the wallet sequence and recovery boundaries.

## Validation

- 334 JavaScript tests passed, none skipped. Added coverage checks the minimal
  deployment plan, preserved infrastructure, resumable journal, stale-tab and
  restart exclusion, historical payment identity, carried allowance display,
  and frozen previous deployment artifacts.
- 140 Solidity tests passed, none skipped. The migration suite includes live
  spending between approvals, both initiating Safes, preserved balances,
  per-Safe capacity carryover, global rejection, epoch rollover, inactive policy,
  unrevoked old grants, replay/wrong caller, and inconsistent old counters.
  This total includes inherited base-policy regressions.
- Controlled browser rehearsal passed on desktop and mobile: three transaction
  prompts plus two owner signatures, lost-wallet-response tracking after reload,
  no duplicate submission, and preservation of both Safe addresses. This fixture
  mocks the engine and wallet; it is UI evidence, not a network broadcast.
- Artifact identity check, Solidity formatting, TypeScript/Vite build and Docker
  image build passed. Existing large-chunk warnings remain. The old TreasuryPolicy
  and BidirectionalTreasuryPolicy deployment artifacts are frozen so pending setup
  requests remain byte-for-byte resumable.

The final native run (`20261021T155655-c25_gbuo`) passed. A legacy policy first
paid 40 on L2. Exactly three migration transactions retained the same Safe
balances and copied 40 of spending. The replacement then settled L1→L2 (70,
split 10+60), L1→L1 (10), L2→L1 (10) and L2→L2 (20), reaching the shared 150
limit. An additional L1 payment failed despite remaining L1 allowance; replay and
forged-caller checks also passed. The harness verified the posted attestation
against independently recomputed inputs and follower convergence through block
215. The previous payment remained verifiable after switching manifests.

Local rollout and read-only browser smoke passed. Only the UI container changed;
monitor, node, signer and runtime configuration are unchanged. The served treasury
asset exactly matches the final build. No public-network upgrade was signed or
broadcast, and the user's browser storage was not edited.

The first native run (`20261021T155238-xhxbt1js`) executed the handover and reached
active-policy reads, then failed the frontend manifest parser: the scripted native
fixture used L2 chain ID 1, which the dashboard rejects. The runner now gives
scripted scenarios the same owned genesis chain ID 420691 already used for UI
scenarios. Production validation was not relaxed. Its failing logs and datadir
are retained locally. The final run and exact result are recorded in `evidence.json`.

Earlier browser fixture iterations corrected a stylesheet path and use of a
non-exported helper; the final fixture uses the public Safe transaction builder.
Early contract negative assertions were moved after signature construction so
they reach Safe execution; timestamp checks use the fixture clock after warps.
These failures were not protocol passes and are not reported as coverage.

## Compatibility and operational limits

Safes and balances are never migrated. The migration policy is new immutable
code; both old delegates retain zero allowances after completion. Administrative
owners can still spend directly, reset allowances, or authorize another policy.
The allowance modules expose separate old/new delegate counters, while the
new dashboard sums carried and new spending for its per-Safe display.

Keep the upgraded UI while a handover is pending. Older frontend builds do not
understand this journal or the carried-spending display; rolling the UI back does
not undo confirmed delegate revocation. A manifest is switched only after all
three transaction inclusions, contract bindings, activation and old revocations
are verified. Reorged or unresolved inclusions block progress. There is no
cross-transaction automatic rollback; finish the remaining owner approvals.

An optional invoice merchant has an immutable, one-time policy binding. The
upgrade preserves its historical records, but omits that fixture from the new
policy. Fixed payments, combined funding and percentage rules work on both
chains. Shared-network setups do not expose the devnet invoice controller.

Private native evidence uses the dashboard-pinned runtime and protocol, a real
Composer/proof signer and independent follower. The running shared-network
node/signer use another recorded revision; private tests do not establish a
successful public wallet or Safe-app execution. Local rollout replaces only the
UI image, not protocol services, network configuration or browser storage. The
user must authorize the upgrade using their connected wallet.

Local artifacts under `.runtime/` are ignored and unavailable to another checkout;
small sanitized hashes, source identities and operation results are retained in
`evidence.json`. No private keys or operator configuration are included.
