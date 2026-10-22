# Repeatable Test USDC requests

The connected treasury now offers **Get Test USDC** as a separate test-only
action. The same wallet can request 450 tokens repeatedly. No per-wallet flag
blocks the UI; each request requires one wallet transaction. Treasury setup
still contains no funding or faucet step. Confirmed faucet hashes are retained,
reload resumes pending work, and no duplicate request can start while one is
pending. Automatic tracking uses the configured L1 explorer and no manual hash
form. See the [accepted change](../../proposals/one-treasury-two-safes.md#accepted-repeatable-test-faucet-2026-10-21)
and [runbook](../../runbooks/treasury-shared-network.md#requesting-more-test-usdc).

The deployed token is immutable: its direct `claim()` still rejects the same
caller twice. `TestUSDCClaim` creates a fresh caller for each explicit wallet
request and forwards the allocation in its constructor. Delivery failure reverts
the mint. This preserves the canonical token, bridge pair, both Safes and policy.
All 20 prior browser deployment artifacts are byte-identical; only the new helper
was added. Outstanding legacy direct-claim calldata is preserved. Older UIs
reject the new indexed request identifiers; keep this build while one is pending.

## Identity and validation

Dashboard base `0d26cf24d2fa23de31021d1a508f137e24804efd`, branch
`feat/treasury-demo`, retaining existing uncommitted work. Protocol pin
`855fe0602484750861b4c31502a1a91355d33ed6`; Solidity 0.8.34 with the repository's
optimizer/via-IR settings and Foundry 1.7.1. No protocol or existing treasury
contract was changed. Exact source hashes are in the local validation record.

- `npm test`: 353 passed, zero failed/skipped. Includes repeated requests,
  retained history and pending legacy calldata, exact helper/token encoding,
  selected-wallet binding and rejection of substituted requests.
- `forge test --root contracts`: 143 passed, zero failed/skipped. New tests verify
  repeats after a direct claim, repeated constructor allocations, empty claim
  helpers and mint rollback on failed delivery; the fuzz case runs 256 inputs.
- `node tests/integration/treasury-deployment-batches.mjs`: 18 cases, 56
  transactions, verified. An already-claimed wallet's direct repeat reverts,
  followed by two successful 450-token requests through the production client.
  Canonical receipts and deployed helper code are checked after journal reload.
  Treasury balances/budgets and aggregate bridge backing remain unchanged.
- Focused served-browser checks pass at 1440px and 390px. Completed direct claims
  and multiple newer claims leave the request action enabled; reload preserves
  hashes, pending work blocks duplicates, and treasury selection is unchanged.
  These use controlled read-only observations and isolated browser storage.
- `npm run build`, artifact consistency, Foundry formatting, JavaScript/Python
  syntax and `git diff --check` pass. The existing Vite size advisory remains.

The first new Solidity test run rejected an obsolete `testFail*`-style name;
the second caught an expected error string that did not match the pinned
SafeERC20 custom error. Both failure logs are retained. The corrected full suite
passes; no assertion or production validation was weakened.

A read-only Chiado comparison reproduced `AlreadyClaimed()` for the existing
wallet, then successfully simulated the helper constructor against the same
canonical token (`0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb`). Its live wallet
balance remained 172.5 Test USDC. No live transaction was signed or broadcast.
The token bytecode hash remains
`0x3e74479f3b2e4316237cf6d3ba680030ba243a0abfd524fb5ec9f6d203c984f9`.

The Anvil fixture uses real contracts in one EVM with read-through EEZ managers,
switched chain IDs and fixture fee responses. It does not prove native Composer
settlement or independent follower replay. No full native E2E or browser-wallet
extension rehearsal was run for this L1-only faucet change.

## Local rollout and evidence

Only the UI container was replaced with `eez-rollup-ui:treasury-repeatable-faucet-20261021` (`sha256:23736c710bb9340ae006247743e58425686be1f2c02dd7191c919f959dff2f92`). Monitor, node and
signer identities and runtime configuration were checked unchanged. Health is
200 and served treasury JS/CSS bytes match the build. No public token, Safe,
bridge or policy deployment was performed; the wallet deploys the claim helper
when the user requests tokens.

Local-only evidence (ignored and unavailable in another checkout):

- `.runtime/treasury-repeatable-faucet-20261021/validation.json`,
  `deployment.json`, `chiado-simulation.json`: source, live comparison and rollout.
- `.runtime/treasury-repeatable-faucet-20261021/browser/`: results and inspected
  screenshots; no browser wallet transaction was requested.
- `.runtime/treasury-deployment-batches/anvil-WhIua6/`: final contract receipts,
  input identity and verified integration summary. The earlier passing run
  `anvil-u9ocxl` predates the additional sender check.
- `.runtime/treasury-repeatable-faucet-{unit-tests,contract-tests}.log`:
  final suites. The evidence directory retains both initial test failures.
