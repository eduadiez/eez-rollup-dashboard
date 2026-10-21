# Direct quote simulation and verified call decoding

| Field | Value |
| --- | --- |
| Status | Implemented and locally validated; not deployed |
| Dashboard baseline | `eduadiez/eez-rollup-dashboard` `4434f0ed661ec8a7b194e18876a5f3aac6c33ace` |
| Branch | `codex/verified-quote-debugger` |
| Candidate patch | Staged non-audit diff SHA-256 `05813a413848adac1c099edec953f7dfae5b9928ae6cc9276e7e9b87db48fdd1` |
| Shared viewer | RollupX `e5e10f0d40588cc0a4f3e4d0fbfc8bec2486bc05`, copied verbatim by the sync script |
| RollupX baseline / protocol | `1ab1e2e3386a8832c7b18224e1eed82fa7c0b074` / `abcf9d8ffc4e0ccb5df271fc19efdf9a7fb57774` |
| Toolchain | Node v26.7.0; locked Playwright 1.63.0; existing dependency lockfile unchanged |
| Chromium SHA-256 | `8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e` |

The candidate digest is `git diff --cached --binary` at the baseline, before
adding this audit. A clean isolated checkout preserved the existing treasury and
operator work. The viewer source commit is local to the shared workspace; no
branches were published and no services were restarted.

## Behavior and boundaries

The new form submits one unsigned debug quote to the selected Composer front
and displays the returned trace without exporting/uploading a file. It preserves
JSON-RPC error envelopes with partial traces. Gas and nonce are optional; value
is explicitly in wei. Quotes require neither a wallet nor fee-enforcement opt-in.

The opaque viewer keeps its offline CSP and accepts a private, same-origin
parent channel. The dashboard decodes explorer-verified ABIs locally, using
observed RPC chain IDs and captured code addresses. Failed chain discovery never
uses wallet development defaults to choose an explorer. Unknown selectors,
fallback-only proxies, constructor inputs, incomplete bytes, foreign chains and
unavailable explorers retain raw evidence. Verified fallback-only contracts can
still have names. ABI metadata does not establish historical bytecode identity.

Lookups are bounded to four concurrent requests, 128 code addresses per selected
run, eight seconds per request and 1 MiB per explorer response. The selected run
owns cancellation. Viewer sequence checks and parent request ownership reject
stale metadata/quotes, including a newer file import beginning before its read
completes. Decoded annotations do not alter exported JSON or execution statuses.

The failure panel distinguishes a parent revert from returned children whose
effects roll back, links the last recorded child without claiming causation, and
identifies shortened fields separately from omitted calls/runs. After a result,
the form/import controls collapse so the tree is visible sooner. Selecting a
call preserves expansion; disclosure arrows and Left/Right keys control it.

## Executed checks

| Check | Evidence | Result |
| --- | --- | --- |
| Baseline build | TypeScript/Vite at `4434f0e` | Passed; produced `index-D7J7tEGl.js`, matching the deployed baseline asset name |
| `npm test` | Dashboard unit suite, including request/ABI/cancellation regressions | 192 passed; zero skips |
| `npm run build` | TypeScript and Vite, default `/dashboard/` | Passed |
| `EEZ_UI_BASE_PATH=/ npm run build` | TypeScript and Vite, root deployment | Passed |
| Browser suites at `/dashboard/` | Built dashboard; mocked RPC and explorer responses; desktop/mobile | 2 passed; zero skips |
| Browser suites at `/` | Same cases against the root build | 2 passed; zero skips |
| Shared viewer | Separate source worktree | 12 model and 3 browser tests passed |
| Whitespace / audit shell example | `git diff --check`, `bash -n` | Passed |

The two browser suites are `tests/quote-trace-debugger.cjs` and
`tests/quote-debug-form.cjs`. They cover direct L1/L2 requests, numeric validation,
tuple/array/custom-error decoding, delegate code addresses, failed chain-ID
discovery, cancellation, imports superseding requests, hostile metadata, raw
export preservation, responsive overflow and absence of signing/broadcasts.

Browser runs used full Chromium with `executablePath: chromium.executablePath()`
and a short, owned `TMPDIR`, working around this host's headless-shell/temp-path
issues. `npm run test:debug` runs these suites normally on a prepared host.

## Provided trace and live metadata

The supplied bare-result trace has SHA-256
`f0b80895cb252a7775b007df82cda675729252b6b9fb8b25d547dcbf0b8fa0f0`.
The local browser harness returned that saved response from a mocked Composer
endpoint after filling the new transaction form. It fetched 13 **read-only,
live L2 explorer metadata responses**, identifying five verified contract ABIs,
including `GPv2Settlement` and fallback-only proxies. L1 metadata was not queried
in this harness; two-chain routing was tested with mocked configured explorers.

All 47 calls imported. The root displayed `GPv2Settlement.settle` and named
arguments containing the order's buy-token address. The summary reported #46's
empty return before #0's revert, and exactly one shortened field: #44 constructor
input, 4096 of 5843 bytes, with zero omitted calls/runs. No browser errors were
observed. This is saved-execution visualization with live metadata, **not a fresh
live quote, transaction broadcast or historical code-match verification**.

Local-only, ignored evidence is under `test-results/quote-debug-real/` and is not
available to another checkout:

- `gpv2-decoded.png`: SHA-256 `3ab801fd047c4787e6ed8c412b56295ddb44fa0b2d0d001c0af8d6ec0779f7b9`.
- `result.json`: SHA-256 `82bbefb7a27b5539c55395729fe9de1c84b621bf2f718cd2ecf8f055b499aec9`.
- `check.mjs`, unit/build/browser logs and synthetic desktop/mobile screenshots
  retain the local reproduction and outputs.

The first diagnostic harness assumed an RPC envelope and stopped before browser
launch; it was corrected to wrap the supplied bare result. A later TypeScript
check rejected a non-exported `AbiError` type; the implementation now derives it
from `Abi`. Both diagnostics are retained locally. Final validation used
fail-fast command groups and rebuilt before all final browser checks; these were
code/harness corrections, not retry-only passes of unchanged failing tests.

The existing bundle-size advisory and dependency audit findings remain; no
dependencies were upgraded. No Rust, Solidity, fee SDK or signing logic changed,
so node/signer/process/replay suites were not run. Mainnet still serves the
previous dashboard until this complete dashboard/viewer bundle is deployed.
