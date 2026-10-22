# Treasury owner integration — 2026-10-20

**Passed:** the dashboard's `L1Owners` and Safe signing helper executed through
an isolated native EEZ devnet, the real proof signer, canonical L1 posting and an
independent L2 follower. This validates the scripted shared-owner foundation.
The connected wallet UI, shared budget, bridge payments and settlement-failure
act remain unimplemented/unverified by this scenario.

## Source and environment identity

- Dashboard branch: `feat/treasury-demo`, base commit
  `0d26cf24d2fa23de31021d1a508f137e24804efd`, plus the uncommitted application/test
  sources hashed in [summary.json](summary.json).
- Runtime: `fa916b13254a36423cad130080dde367bb18a7d6` **plus existing local edits**.
  [runtime-source-overrides.json](runtime-source-overrides.json) records each
  modified/additional runtime source and its tested SHA-256. These edits predated
  this task and were preserved. This is not evidence for an unmodified release.
- Core: `855fe0602484750861b4c31502a1a91355d33ed6` in both checkouts, with no
  tracked implementation edits.
- Safe v1.4.1: `bf943f80fec5ac647159d26161446ac5d716a294`; allowance source pin:
  `c95f03900bff99be090dadb9de1c74b162365485`. This process scenario uses the Safe
  owner adapter; it does not exercise allowances.
- Foundry 1.7.1, Rust 1.95.0, Node 26.7.0, LLVM/Clang 22. Contracts use the
  compiler settings documented in the [contract project](../../../contracts/README.md).
- Fresh private EthereumOsaka fixture, L1 chain ID 1337 and L2 chain ID 1,
  isolated genesis/state, leased loopback ports and public fixture keys. The L2
  chain ID does not mean Ethereum mainnet. No operator `.env`, live balances,
  running service or deployed dashboard was changed.
- Native development miner, local bundle-forwarding relay and Beacon sidecar
  fixture; real Composer, proof signer and follower validation. Production PBS
  ordering, external RPC operation and public-network finality were not tested.

The [summary](summary.json) records SHA-256 identities of all three runtime
executables, the compiled test harness, application sources and the retained
runtime-source inventory. Sources were checked unchanged across the build/run.
The external dependency identities in the harness lockfile were checked against
the runtime lockfile; builds used `--locked` after deriving that harness lock.
No runtime source or proof-validation change was made for this integration.

## Command and results

Run from the dashboard repository root; [prerequisites and runner details](../../../tests/integration/README.md):

```bash
npm run test:treasury:integration -- --runtime /home/edu/Development/rollupX --cargo-target-dir /home/edu/Development/rollupX/target
```

The optional target directory only reuses the runtime compilation cache. All
new test code, scripts, fixtures, generated configuration and logs live in the
dashboard repository. The successful harness selected **one test with five
scenario cases**; the development L1 was ready in 27.365 seconds.

| Case | Observed result | Safe nonce / action value |
| --- | --- | --- |
| B+C before C is an owner | Composer discards source; L1 Safe verification reverts | 0 / 0 |
| Add C on L1, submit the same B+C Safe approval | Canonical L2 block 60; independent follower agrees | 1 / 42 |
| Replay the consumed approval | Composer discards source; L1 Safe verification reverts | 1 / 42 |
| Sign with B+C, then remove C on L1 before submission | Composer discards source; L1 Safe verification reverts | 1 / 42 |
| A+B after removing C | Canonical L2 block 75; independent follower agrees | 2 / 43 |

Each successful case checks the canonical receipt/block identity, Safe nonce,
action value and caller on both Composer and follower. A canonical L1 batch
trace must contain the exact Safe transaction hash in a successful static
`checkSignatures` call to the L1 Safe. The final safe-prefix comparison reached
L2 block 75, hash
`0xa1efd1987e0833e88df0a696c77ee32ced74b0fb142f974a443a09985243e156`.
The test independently recomputed the latest posted batch's public-input hash
and recovered its expected attester; both nodes had no divergence-failure logs.
The L2 Safe retained its single `L1Owners` owner and threshold 1 throughout.

Negative cases submit actual signed source transactions to the Composer and
require terminal `PoolDiscarded`, no receipt, and unchanged submitter nonce,
Safe nonce and action value. Existing opt-in Composer traces must reach a
`REVERT` instruction in the L1 Safe. The same preimage/signatures are checked
separately against the L1 Safe for `GS026`, because queue-status RPC does not
expose revert bytes. Replay uses the Safe's current nonce when reconstructing
that preimage. These are composition rejections, not L1 inclusion rollback.

[scenario.json](scenario.json) records owner-change transactions, deployment code
hashes, both settled L2 identities, their L1 verification transactions and the
negative dispositions. Owner signatures use public fixture keys and the real
dashboard EIP-712/contract-signature helper, not wallet-extension interaction.
Setup provisions both the L1 Safe's L2 proxy and the adapter's L1 alias before
verification; a static call cannot create a missing proxy.

## Retained attempts and limits

Full logs, composition traces, executable copies and source inventory are
**local-only**, ignored under `.runtime/treasury-integration/`. The compact JSON
records in this audit are available to another checkout; the local runtime
patch contents and full diagnostic artifacts are not committed here.

| Run directory suffix | Result |
| --- | --- |
| `20261020T110353-7rpnqsvb` | Harness startup failed because its isolated fixture directory omitted the runtime's builder helper. The runner now copies the existing helper. |
| `20261020T111545-bmdqzpwj` | Setup succeeded, then the negative preflight incorrectly used ordinary `eth_estimateGas`. It returned `ExecutionNotInCurrentBlock` because that path lacks cross-chain execution tables. The test now submits through the Composer and verifies its actual disposition. |
| `20261020T112247-bdym7b14` | All five cases and independent validation passed. |

The earlier failures are retained and are harness corrections, not discarded
flaky passes. Failed-run datadirs remain available for diagnosis. After the
successful run, all five owned RPC listeners were checked closed and its
disposable datadir directory was empty.

The existing 23 Solidity tests (including 256 fuzz cases) and 185 dashboard tests
also passed during this task. Script syntax, Rust formatting, Foundry formatting
and documentation whitespace checks passed. No full runtime workspace suite,
core Anvil matrix, production PBS/Kurtosis run or connected browser rehearsal was
run: runtime/protocol implementation and the UI were not changed. Full Phase 1
acceptance still requires the actual owner/signing screens and L1 Safe-app flow.
