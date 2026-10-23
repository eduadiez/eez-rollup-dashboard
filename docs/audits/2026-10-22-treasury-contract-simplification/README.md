# Treasury contract simplification

## Scope and identity

Implementation began from dashboard commit
`34765d3dcbf8507d6cbda61b98d98bf8b44949f7` on
`codex/treasury-demo-release`. The user authorized shared EEZ-X infrastructure,
removing the mainnet alias reader and moving invoice code out of both public
policy variants. Missing shared contracts are prepared by the connected wallet
in normal setup batches. Compatibility with older policy constructor layouts
is outside this change.

The accepted design is recorded in the
[proposal](../../proposals/one-treasury-two-safes.md#accepted-treasury-contract-simplification-2026-10-22).
The core pin is `855fe0602484750861b4c31502a1a91355d33ed6`, Safe is
`bf943f80fec5ac647159d26161446ac5d716a294` and Safe modules are
`c95f03900bff99be090dadb9de1c74b162365485`. No pins or environment settings changed.
The new deployment/verification build is
`41f1c1c5c18a6e4a534055c105c5fda77437321634db5a267d48e106f8034443`, containing
18 contract types. Historical immutable source bundles were not rewritten.

## Result

- Bootstrap creation logs discover the Safe singleton, proxy factory,
  call-only batch helper and allowance module. Creation hashes locate candidates;
  exact runtime at a canonical block authorizes reuse. Missing contracts are
  deployed through the connected wallet. RPC errors stop selection. Later wallets
  reuse the contracts, and saved code identities are rechecked before preparation.
- A shared module already enabled on the selected Safe is omitted from the
  signed configuration batch. A change to enablement invalidates approvals.
  Other delegates, Safe owners, thresholds and allowance counters are preserved.
- The standard-bridge policy reads its alias from the funding delegate's
  one-time Safe-authorized binding. The client independently checks that alias
  against the registry. Mainnet setup no longer selects or provisions an alias
  reader. Chiado's existing bridge API retains its reader.
- Public policies have eight constructor arguments and no invoice entry point,
  fields or proxy. Invoice handling is in isolated fixtures under
  `contracts/test/fixtures`, excluded from the public release. Production rollback
  tests fail an ordinary later token/bridge leg.
- Optimized runtime size changed from 14,563 to 10,683 bytes for the Chiado policy
  and from 14,626 to 10,238 bytes for the standard-bridge policy. These are bytecode
  measurements, not gas or security claims.

## Validation

Commands ran from the dashboard root with Node 26.7 and Foundry 1.7.1.

| Check | Result |
| --- | --- |
| `npm test` | 449 passed, none failed or skipped. Includes cross-wallet discovery, absent/spoofed/removed candidates, bounded history ranges, canonical recheck, chain mismatch, RPC failures, code changes and delegate/alias validation. |
| `forge test --root contracts` | 236 passed, none failed or skipped, including Safe 1.3/1.4/1.5 compatibility and both production policies. The final fixture-only simplification was followed by all three `TreasuryInvoiceTest` cases passing. |
| `forge fmt --check --root contracts` | Passed. |
| `npm run check:treasury-release` | Exact sources, pins, 18 deployment artifacts and retained verification inputs agree. |
| `npm run build` | TypeScript and Vite passed; existing chunk-size warnings remain. |
| `node tests/integration/treasury-deployment-batches.mjs` | Passed with the current release. Real Safe/allowance/token contracts exercise reuse across wallets, an already-enabled shared module, exact signed batches, both split-payment destinations and independent budgets. |
| `node tests/integration/treasury-source-verification.mjs` | Six actual isolated deployments passed exact recompilation, nested creation discovery and persistent restart recovery. Explorer transport is controlled. |
| `TMPDIR=<owned temporary directory> node tests/treasury-mainnet-setup-browser.mjs` | Passed: selected Safe addresses, connected deployment wallet, no mainnet faucet and preserved Chiado journals. |
| Read-only Chiado discovery | Found all four exact-runtime EEZ-X contracts through the new discovery path. No broadcast. |
| Operator state | Hashes of all 12 recorded environment/retained artifact/network files remained unchanged. |

The setup integration uses one owned Anvil to model two logical chains. Its
network IDs and chain-specific creation-log views are fixtures; it does not
establish Composer, proof signing or independent derivation. Native evidence is
recorded separately below. Neither controlled explorer responses nor a local
compiler pass establishes acceptance by a public explorer.

## Native settlement and rollback

The final run `.runtime/treasury-integration/20261022T215319-xkpfpui0/` passed,
including the runner's final application and runtime source-integrity checks.
It reused verified binaries from runtime commit
`fa916b13254a36423cad130080dde367bb18a7d6`, with the pinned core revision above.
The Composer, proof signer and independent follower ran on newly owned ports and
datadirs. Actual bridge/USDC runtime bytecode was cloned from the retained mainnet
snapshot into fresh fixture state; no public assets or public transactions were used.

The scenario covered owner addition/removal, the 40 / 110 / rejected-1 budget
sequence, both initiating Safes and both destinations with exact splits, and the
10% combined-balance rule. Every settled scripted payment was checked against
independent follower replay. The browser used genuine fixture signatures with
an EIP-1193 test provider, submitted once through Ethereum and recovered after
reload and loss of the wallet response.

For rollback, the original proof/blob commitments were retained while a controlled
USDC blacklist update was included before the payment. The canonical execution
trace proved an earlier successful bridge release and a later rejected token
transfer. Both Safe/recipient balances, allowance counters and nonces, shared
spending, bridge escrow/supply and temporary balances/approvals matched their
pre-payment values. The source reverted and Composer reached terminal disposition.
The harness separately verified the posted attestation and final follower state.

```bash
python3 scripts/run-treasury-integration.py \
  --runtime ../rollupX \
  --reuse-run .runtime/treasury-integration/20261022T162532-6x12i0y9 \
  --standard-bridge-snapshot .runtime/treasury-integration/20261022T162532-6x12i0y9/mainnet-snapshot.json
```

The referenced runtime artifacts and snapshot are local-only. The runner checks
source and executable hashes before reuse; a fresh checkout must prepare the
pinned runtime and snapshot through the existing
[mainnet rehearsal procedure](../../runbooks/treasury-mainnet.md).

## Corrections retained during validation

Initial contract tests exposed a Safe 1.5 expectation mismatch: that version
bubbles the token-module error while Safe 1.4 emits `GS013`. The test now uses its
existing version-specific expectation and still asserts rollback. The unbound
funding-delegate fixture also needed its canonical caller alias registered before
it could reach the intended `InvalidConfiguration` error.

Initial setup regressions used an old nine-argument policy artifact, reused a mock
CREATE nonce and returned the first wallet as the second bootstrap's owner. They
were corrected to exercise the current release and real per-wallet identities.
The one-EVM rehearsal now separates logical-chain IDs and creation logs; without
that separation its L1 deployments appeared to be EEZ-X deployments. These were
fixture corrections, not production validation bypasses.

Chromium initially terminated with SIGTRAP before executing browser assertions
when using the host `/tmp`. The browser check passed with its profile in an owned
repository temporary directory. Original failed outputs are retained alongside
the corrected runs. No failed runtime assertion was accepted as a pass.

The first native run (`20261022T214418-fpx8rugg`) completed its payment, browser,
rollback and follower assertions, but the runner's final source-integrity check
rejected concurrent edits to application/test files. That run is not counted as
a successful candidate validation. The complete scenario was repeated after
freezing the application sources.


## Evidence and limits

Detailed local-only evidence is under
`.runtime/treasury-contract-simplification-20261022/`. Successful setup evidence is
`.runtime/treasury-deployment-batches/anvil-jK9c4h/`; verification evidence is
`.runtime/treasury-auto-verification-20261022/anvil-4nJIcy/`.
These ignored directories are not available in another checkout; the accompanying
[results file](results.json) retains source/build identities and log digests.

No contracts were broadcast on a public chain, no operator account was used, and
no deployment service was restarted. The first missing mainnet infrastructure
still requires the connected wallet's normal setup confirmations. This work does
not replace independent contract review or actual public wallet/Safe-app acceptance.
