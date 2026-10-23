# Node and React security update — 2026-10-23

## Scope and baseline

Updates the dashboard runtime and JavaScript dependencies before the treasury
branch is committed and pushed. Existing treasury changes, contract artifacts,
network profiles, `.env` and pending-transaction storage are preserved.

- Branch: `codex/treasury-demo-release`; base HEAD: `a96bc5cd3e7df91ac585ce7cdf6303f82fc7bfb6`, with the existing uncommitted treasury work as the baseline.
- Protocol: `855fe0602484750861b4c31502a1a91355d33ed6`.
- Contract release remains `026c1f779c5c3bed2cc56f91707bb7b9eca67c240ef7cfd47ca83017cb868df1`.

The [October 21 Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
includes CVE-2026-111497, a Brotli decoder out-of-bounds write that can allow
remote code execution, along with other runtime fixes. The project retains its
existing Node 22 line and pins the patched 22.23.4 release in both Docker stages
and `.nvmrc`; CI reads `.nvmrc`. Package engines require the patched minimum on
the supported 22, 24 and 26 release lines.

The dashboard is a client-rendered Vite application. Neither the resolved
packages nor application source use React Server Components or server functions,
so the [React server-function advisory](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g)
does not describe this application's React execution path. React and React DOM
are nevertheless updated together to the current stable 19.3.1 release.

| Dependency | Previous resolved version | Updated resolved version |
| --- | --- | --- |
| React / React DOM | 19.2.4 | 19.3.1 |
| React / React DOM types | 19.2.14 / 19.2.3 | 19.3.0 / 19.3.0 |
| Vite | 6.4.1 | 6.4.5 |
| viem | 2.47.0 | 2.57.10 |
| ws, through viem | 8.18.3 | 8.21.0 |

The initial npm audit reported 10 affected packages, including Vite, ws and build
tooling. Targeted compatible updates also refresh Babel, Browserslist, PostCSS,
nanoid, picomatch and source-map-js. No forced upgrade, dependency override or
lockfile-only integrity edit was used. CI now rejects high/critical npm advisories.
The existing TypeScript, Playwright, React Vite plugin and Zustand versions remain.

## Validation

All commands run from the dashboard root under Node 22.23.4 / npm 10.9.9. The
local Node archive was downloaded from nodejs.org and checked against its official
SHA-256 manifest. The shared host's default Node installation was not replaced.

Final checks passed: 420 JavaScript tests, six treasury browser suites, 112
bridge/counter browser scenarios, both isolated native rehearsals, clean builds
and zero known npm vulnerabilities. Results and local evidence hashes are
recorded in [results.json](results.json).
The validation includes a clean `npm ci`, the 420 JavaScript tests, TypeScript and
production build, browser fixtures, immutable-release verification, isolated
source verification, both Docker targets and a container startup check with
mocked dashboard/RPC configuration and no external network access.

The native rehearsals use exact, verified artifacts from runtime revision
`fa916b13254a36423cad130080dde367bb18a7d6`. They exercise real signatures, Composer,
signer, canonical settlement and independent replay on disposable networks. The
standard-bridge rehearsal uses the retained Ethereum/USDC runtime snapshot with
fresh isolated state; it is not a live Ethereum transaction or a new mainnet fork.

### First failures and corrections

- A setup-browser invocation supplied an absolute evidence path to a harness
  that expects a relative path. Chromium never launched; the corrected invocation
  uses a relative path.
- Chromium launches using the shared `/tmp` terminated with SIGTRAP before the
  mainnet chooser and Bridge & calls assertions. Dedicated workspace temporary
  directories were used for the subsequent runs; the original logs remain.
- The first faucet run failed on a dynamic fixture import. A diagnostic rerun
  passed and exposed blocked HMR WebSocket connections. This is retained as a
  flaky first result, not a clean pass. HMR is now disabled in this static fixture
  so hot-reload reconnects cannot interfere with its explicit reload-recovery
  assertions. The final run retains all original assertions.
- Both initial native runs completed their semantic and independent replay
  assertions, but their wrappers rejected the evidence because the faucet test
  changed during execution. Those runs remain rejected. Final runs start after
  that edit and retain the complete source-identity check.

## Deployment boundaries

Only isolated test processes and new local image tags are created by this update.
No existing service, browser storage, Safe, token, bridge, verification queue or
operator configuration is replaced. The running verification container was read
and already reported Node 22.23.4; the new pin prevents relying on a floating tag.
The updated frontend and dependency bundle still need the normal build/deployment
procedure after review. There was no public broadcast, push or PR creation.

The npm audit result describes known package advisories at the time of the check;
it is not a complete security audit. This update does not independently audit the
demo smart contracts. Browser fixtures mock wallet/RPC responses, and the native
rehearsals use injected fixture wallets rather than a real extension/Safe app.
No full Solidity unit rerun was required because this update does not change
contracts; the release check and native contract builds still validate their
unchanged inputs. Detailed logs and datadirs under `.runtime/` are local-only and
are not available from another checkout.
