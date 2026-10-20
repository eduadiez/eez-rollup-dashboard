# Dashboard cross-chain fee validation

| Field | Value |
| --- | --- |
| Date / status | 2026-10-19 UTC / passed within the recorded scope |
| Scope | Compact fee quotes for both dashboard directions, legacy/EIP-1559 signing requests, independent configuration, existing UI regressions and private settlement |
| Dashboard baseline | `origin/main` at `b757fb09375b829dda53b42e52886fdd292ff583`; prior local fee work at `dcf4ac71b62ebc7bf5ac10cdb426e1f48ce11e00` |
| Candidate | `feat/cross-chain-fee-quotes`; exact shipped content identified below |
| Backend | Merged RollupX `51ef1ba08d5c506c8909bc8be2e16e8d25c0a7a8`; local orchestration checkout `e00688ea99c1799b625e7baf546451a2583e0549` has the identical Git tree |
| Protocol | `abcf9d8ffc4e0ccb5df271fc19efdf9a7fb57774`, clean initialized checkout |
| Environment | Production nginx image built with Node 22; Chromium via pinned Playwright 1.63.0; private Kurtosis chain IDs 7331/696990 |

## Source and executable identity

The dashboard image tested was `eez-rollup-ui:fees-pr-20261019`, local image ID
`sha256:e86606098774e346b7f01ede01b7a622bdb5638c17a7aa8402468e903d2f3c93`.
It has not been published. SHA-256 hashes of the shipped content:

| File | SHA-256 |
| --- | --- |
| `assets/index-D3zC8vLd.js` | `84e8a5ebc1241f4588ced516b926dfaee84d4a7db9d723421180343aa4b35ca2` |
| `config.template.json` | `7c955a37bbaa885d6fbd39882a0ef379fc6ad17d91d50a46edfa50cb09b4ac26` |
| `docker/30-eez-runtime-config.sh` | `457dadd8aa49c504a39fad09e29893be92c30a1804886dde04885ef886a6492d` |

The vendored SDK and its tests were compared byte-for-byte with the backend
revision above. Private-network tests used these published backend images:

- `ghcr.io/eez-association/eez-rollupx-node@sha256:4a9a38cc729ee368f8a2bd398d2f44291a1bf0b5646b2a2821efb25ed2faab62`
- `ghcr.io/eez-association/eez-rollupx-proof-signer@sha256:0be7f739b448955d2061f2cc72d90d2f8800252b2d0dcdf7aaae8c848467d9b4`
- `ghcr.io/eez-association/eez-rollupx-deploy@sha256:5491388cc3738a596ba4c295c42d62f8d4105dcfdd13f6c0d19bb45282bcca11`

## Reproduction and results

Commands ran from the isolated dashboard checkout. Test setup and required
variables are documented in the [README](../../../README.md#checks).

| Check | Kind | Result |
| --- | --- | --- |
| L1 fee-enabled bridge at `dcf4ac7` | Mocked browser baseline | Failed: one wallet send, zero `eez_quoteFee` calls; expected one quote |
| `npm run build` and Docker build | TypeScript / production build | Passed |
| `npm test` with Node 22 | Unit | 174 passed; zero failed, cancelled or skipped |
| `tests/cross-chain-fees.cjs` | Mocked browser against Docker image | 40 passed, including the L1 baseline regression |
| `tests/cross-chain-call-fees.cjs` | Mocked browser against Docker image | 8 passed: ABI/raw calls in both directions and wallet formats |
| `tests/bridge-gas-fees.cjs` | Mocked browser regression | 27 passed |
| `tests/cross-chain-calls.cjs` | Mocked browser regression | 25 passed |
| `tests/counter-demo.cjs` | Mocked browser regression | 17 passed |
| `tests/bridge-readiness.cjs` | Mocked browser regression | 7 passed |
| `npm run test:fees:config` | Compose plus actual image entrypoint | 25 passed; absent/empty defaults, independent flags/caps, shell precedence, invalid flags/caps; invalid inputs also reject in the Vite helper before any Kurtosis call |
| `scripts/configure-kurtosis.sh` | Live private-enclave configuration | 3 additional cases passed: absent, empty, and different per-chain values; previous runtime file restored |
| Shell/JS syntax, README shell examples, `git diff --check` | Static | Passed |
| `npm run test:fees:kurtosis` | Live private settlement | All 6 passed after correcting the bridge fixture direction: legacy/type-2 proxy calls and native bridges in both directions |

The initial dev-server browser run failed waiting for the connect button; the
compiled nginx image was then used for the recorded browser results. The new
contract-call test initially expected a raw-calldata input on an ABI-based form.
The fixture was corrected and expanded to exercise both ABI and raw modes.
The first live run passed five cases, then its L2 bridge fixture failed before
signing because it had not changed the fresh form's L1-to-L2 default. The test now
explicitly selects L2-to-L1 before submitting. These fixture failures are retained
locally; they are not counted as passing checks.

Private-chain validation uses a dedicated prefunded fixture account and the
profile's explicit parity cost model, 20% quote margin, zero off-chain allowances,
90% L1 refund, and distinct L1/L2 recipients. Fresh PBS readiness is awaited
before quoting. Tests assert canonical consumption and destination state, not
just relay acknowledgements or source receipts.

## Evidence and limits

[Sanitized settlement results](settlements.json) retain the final six source/post
hashes, observed tip/refund, posting cost and canonical destination assertions.
All six recovered at least the observed posting and blob cost. The configured
20% quote margin is not a guarantee of an exactly 20% realized surplus.


The full final live evidence SHA-256 is `de72aebbbb1f7573e6cab83209c4027b4be3f2e41580f2c838ab1ebb39b66790`.

Full logs, image hashes, network arguments and live transaction records are in
the operator's `dashboard-fees-pr-evidence-20261019` artifact directory. These are
**local-only**, not published or available from another clone. The committed
summary and test sources provide the reproduction path; the ephemeral private
network is not a public explorer.

This is application integration validation, not an independent security audit.
The wallet adapters exercise standard EIP-1193 calls and local fixture signing;
actual Rabby/MetaMask extension simulation and production broadcast routing are
not covered. Safe gas bounds have SDK tests; live Falcon Safe, nested protocol
stress, public builder qualification, throughput and independent follower replay
were not run for this dashboard change. Existing npm audit findings and the
Vite large-chunk warning were not addressed by incidental dependency upgrades.

Only an isolated local dashboard and private Kurtosis enclave were started.
Existing operator configuration, the original dashboard checkout and live
Chiado/mainnet services were preserved. No branch, PR, image or site was published.
