# Dashboard quote debugger

| Field | Value |
| --- | --- |
| Date | 2026-10-20 UTC |
| Status | Local validation complete; prepared for manual publication |
| Dashboard baseline | `eduadiez/eez-rollup-dashboard` main `9afaaa5a453a663a32fb4593d2bdbec204972ec2` |
| Dashboard branch | `codex/quote-trace-debugger` |
| Viewer source | RollupX `353be39dd369fe4da1935796dcc23cd729f81398`, [PR #97](https://github.com/eez-association/eez-rollupX/pull/97) |
| Environment | Node 26.7, pinned npm lockfile, Playwright 1.63.0/Chromium |
| Scope | Debug navigation, isolated JSON viewer, source synchronization, browser validation |

The existing dashboard checkout has unfinished treasury work. This integration
uses a separate checkout of published main; it does not include or modify that
work or operator configuration.

## Implementation and compatibility

`#/debug` loads the same static viewer maintained in RollupX. The fixed asset
list is copied from a committed revision through
[`sync-quote-trace-viewer.mjs`](../../../scripts/sync-quote-trace-viewer.mjs);
the [source record](../../../public/quote-trace/SOURCE.md) identifies that revision.
All five source and built files were compared byte-for-byte with Git blobs.
This avoids developing a second call-tree renderer or parser.

The iframe permits scripts and downloads but does not permit same-origin
access. The viewer's content policy forbids network connections. Imports remain
in browser memory and cannot access the parent wallet context. Tracing itself
requires a Composer implementing PR #97; imports of existing exports work
independently of the running Composer revision. There are no new runtime
configuration settings, fee rules, contracts or storage migrations.

The upstream cleanup makes file selection keyboard accessible and ensures a
slow prior file read/error cannot overwrite a newer import or paste. Embedded
mode hides the viewer's standalone brand header.

## Validation

| Check | Result |
| --- | --- |
| Production build / TypeScript | Passed for `/dashboard/` and `/` |
| Existing unit/script test selection | 9 test files passed, none skipped |
| Built dashboard browser integration | Passed at both base paths, each importing all nine real Composer exports plus the recorded nested revert |
| Existing bridge fee browser suite | 52 mocked Rabby/MetaMask scenarios passed |
| Existing cross-chain-call fee browser suite | 16 mocked scenarios passed |
| Vendored/build asset comparison and documentation links | Passed |

The integration test checks direct linking, refresh, back navigation, desktop
and mobile navigation, ordinary dashboard/Visualizer navigation, file/paste
imports, quote errors versus successful source execution, caught failure,
ancestor rollback, expand/collapse, exported JSON equality, malformed input,
origin isolation and absence of viewer uploads/RPC calls. It runs without a
connected wallet. Both layouts were visually inspected. Vite reports a
nonfatal main-chunk size warning; these changes do not add a bundled JavaScript
dependency to the dashboard.

The first browser assertion selected frame 2 as a successful rolled-back child.
In the actual recorded trace frame 2 reverts; frame 5 succeeds and is rolled
back by its ancestor. The assertion now selects frame 5. The first failure and
corrected results are retained locally; this was a fixture assertion correction,
not a retry-only pass. An initial asset-sync invocation was blocked by the
execution sandbox's Node subprocess restrictions; the authorized local rerun
read the committed Git blobs successfully.

Commands from this checkout:

```bash
npm ci --offline --ignore-scripts
npm test
npm run test:debug
EEZ_UI_BASE_PATH=/ npm run test:debug
```

For this run, `EEZ_TEST_LOG_DIR` additionally selected the final RollupX
`quote-traces/` process exports described in its
[validation record](https://github.com/eez-association/eez-rollupX/blob/353be39dd369fe4da1935796dcc23cd729f81398/docs/audits/2026-10-20-quote-call-tracing/README.md).
The bridge/call browser scripts ran serially against a production preview on
an ephemeral loopback port with `EEZ_UI_URL` set accordingly. All RPC responses
and wallet requests in those scripts are mocks; no transaction was broadcast.
The final build uses the default `/dashboard/` prefix.

Local-only logs are `/tmp/eez-dashboard-debug-*.log`; screenshots are under
ignored `test-results/quote-trace/{dashboard,root}/`. These locations are not
published evidence available to another checkout. The small nested-revert
example is committed and contains only public fixture addresses.

No live wallet extension, Docker image/deployment, reverse proxy, or public
Composer was exercised by this dashboard validation. The backend's full
release/Kurtosis CI is separate and remains required before release.
