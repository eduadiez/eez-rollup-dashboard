# PR #11 integration and merge-blocker validation

This record covers the integration of native trace details with the treasury and
security updates already on `main`. It does not establish live cross-chain
trace coverage or authorize production deployment.

## Source identity

- Original PR #11 head: `d0f5a4dbe173eb0765ffd76aadffe7d4f9fb0dd4`.
- Target `main`: `f2ebc29eb8085f8c83bd41f0d78f6e2a77bd4e21`.
- Merge base: `9afaaa5a453a663a32fb4593d2bdbec204972ec2`.
- Candidate: the merge commit containing this record; both revisions above are
  parents, so the contributor's commits remain in history.
- Core gitlink: `855fe0602484750861b4c31502a1a91355d33ed6`.
- Safe gitlink: `bf943f80fec5ac647159d26161446ac5d716a294`.
- Safe modules gitlink: `c95f03900bff99be090dadb9de1c74b162365485`.
- Node `22.23.4`; npm `10.9.9`; Foundry `1.7.1`.

Treasury sources, dependencies, saved-state handling, and immutable release bundles
remain identical to target `main`. Recompiling produced release
`026c1f779c5c3bed2cc56f91707bb7b9eca67c240ef7cfd47ca83017cb868df1` again.

## Corrections

The merge retains treasury navigation and source verification together with the
native trace view. The local/host-network decoder listener and proxy default move
to port `18082`; treasury verification retains `18081`. Standard Compose still
uses the decoder's private port `8080`. Existing `.env` files need no new setting.
An operator who explicitly overrides the trace listener or Vite upstream must
keep those two overrides consistent and avoid the verification port.

The decoder uses `ethers@6.17.0` and `ws@8.21.0`, and its Docker image pins the same
Node patch as the dashboard. Root and decoder lockfiles are audited separately.

The existing CI workflow installs and audits both packages, runs the decoder
fixture suite and self-contained trace browser test, validates both Compose
modes, builds all three Node/UI images, and runs the service-coexistence check.
The new smoke test fills the gap left by testing service handlers without starting
the shipped listener/worker. It binds a verification fixture inside an isolated
Docker network namespace; it never reserves the operator's host ports.

## Checks

Run from the repository root with the tool versions above:

```sh
npm ci
npm ci --prefix trace-decoder --ignore-scripts
npm audit --audit-level=high
npm audit --prefix trace-decoder --audit-level=high
npm test
npm test --prefix trace-decoder
npm run check:treasury-release
npm run test:contracts
forge fmt --check --root contracts
npm run build:treasury-release
node tests/integration/treasury-source-verification.mjs
node tests/integration/treasury-deployment-batches.mjs --current-release
node tests/treasury-setup-completion-browser.mjs
node tests/treasury-mainnet-setup-browser.mjs
node tests/treasury-faucet-browser.mjs
node tests/treasury-verification-browser.mjs
node tests/trace-details.cjs
npm run build
docker compose --env-file /dev/null config --quiet
docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.host-rpc.yml config --quiet
docker build --target verification -t treasury-verification:check .
docker build -t treasury-ui:check .
docker build -t eez-trace-decoder:check trace-decoder
node tests/trace-services.mjs
```

Local validation used unique image tags and an isolated worktree. Both audits
reported zero vulnerabilities; 420 dashboard unit tests, 257 decoder fixture tests,
and 134 contract tests passed with no skipped tests. The production UI build,
contract formatting/release checks, five browser scripts, both Compose modes,
and three image builds passed. Isolated Anvil verification checked six real
deployments with exact recompilation and queue recovery; the deployment-batch
check passed 19 scenarios, including both payment directions, funding splits,
shared-budget rejection, and pending setup recovery. The service check passed for the local default,
host overlay, and standard container, and loaded the real worker/engine before
rejecting a network mismatch without RPC access.

The same service check against the original PR image failed with `EADDRINUSE`
on port `18081`, demonstrating the regression before and after the correction.
The initial smoke harness reused a closed HTTP socket and inherited a stdin-only
Node option in workers; the corrected harness closes its HTTP connections and
runs from a module file, matching production startup. These diagnostic failures
are retained separately from the successful final check.

The existing mainnet browser test initially failed before launch when Chromium
used the machine's quota-limited `/tmp`. It passed with a private `TMPDIR`; this
was an environment correction, not an application retry or code change. Unit
checks also used a private `TMPDIR`. Existing Vite chunk/import warnings and
Foundry lint warnings did not fail their commands.

Raw logs, container build identities, and isolated Anvil/browser evidence are
local-only under the integration worktree's ignored `.runtime/` directory and
its parent; another checkout cannot retrieve them. GitHub Actions uploads its
own `.runtime/` evidence with a seven-day retention period.

No operator services were restarted, no existing treasury configuration was
changed, and no public-chain transactions were sent. The decoder suite uses
synthetic traces; the browser tests use controlled API/RPC fixtures. The Anvil
checks use real contracts and compiler outputs with controlled discovery and
explorer transport, not EEZ settlement/proofs or independent follower replay.
The optional legacy decoder suite requires artifacts from its original protocol
checkout and is excluded. Native protocol E2E and live mainnet/Chiado trace
rehearsals were not run for these deployment/CI changes.
