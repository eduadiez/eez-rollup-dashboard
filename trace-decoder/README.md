# Cross-chain trace decoder

Decodes one EEZ transaction (L1 or L2), finds the related transactions on the other
chain, matches every cross-chain call to its remote execution, and draws the flow.
Read-only: it only uses RPC reads/traces and explorer lookups.

This folder originated in `sync-rollups/trace-decoder`. Its JSON engine and flow
model now power the dashboard's native React transaction detail view through a
read-only Node.js API. The API runs as the internal `trace-decoder` Compose service.
The CLI and standalone HTML viewer remain available for offline inspection.

## Dashboard API

The dashboard uses `service/server.mjs`, which imports the engine directly.
Configuration comes from the shared root `.env` and exported variables. To run
locally once dependencies are available:

```sh
node trace-decoder/service/server.mjs
```

It binds to `127.0.0.1:18081` by default. Compose binds internally on port 8080;
the host-network overlay uses loopback port 18081. `EEZ_TRACE_HOST` and
`EEZ_TRACE_PORT` override the listener. `EEZ_TRACE_TIMEOUT_MS` (default 120000)
and `EEZ_TRACE_CONCURRENCY` (default 2, maximum 4) bound worker jobs.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Process/configuration readiness; does not probe RPCs |
| `POST /api/jobs` | Start or share a decode; body: `{ hash, chain: "l1" \| "l2" \| "auto", chainIds: { l1: "10200", l2: "200" }, refresh?: true }` |
| `GET /api/jobs/:id` | Poll state and progress; renew the viewer lease |
| `GET /api/jobs/:id/result` | Retrieve the versioned public flow model |
| `DELETE /api/jobs/:id` | Release this viewer's lease |

Chain IDs are decimal strings checked against the configured upstreams. Selecting
a source chain restricts hash discovery without restricting related-chain decoding.
The service accepts no client-supplied endpoints or credentials. Each decode runs
in a bounded worker thread; cancelling the last viewer or reaching the deadline
terminates the worker and its outstanding requests. Viewer leases expire after
45 seconds without polling. Results are limited to 8 MiB, total cache memory to
32 MiB, jobs to 16, and clients to 64. Individual upstream bodies are limited to
16 MiB, concurrent upstream fetches to eight per worker, and RPC/explorer work to
6000 requests (JSON-RPC batch elements count separately).

Completed snapshots cache for 30 seconds, partial snapshots for 5 seconds.
Refresh bypasses completed snapshots. Results carry their observation time and
do not assert current finality. Public responses omit provider error messages,
configuration, and raw Composer responses. The public contract is
`service/types.d.ts`; the React view consumes it with no Node dependencies.

## Show a transaction

```sh
trace-decoder/show-tx.sh <TX_HASH>
```

Every transaction it finds (the requested one and the related L1/L2 ones) must have a
call trace. If an endpoint cannot trace one, it exits with an error naming the
transaction and the missing setting (`EEZ_UI_L1_TRACE_RPC_UPSTREAM` / `EEZ_UI_L2_TRACE_RPC_UPSTREAM`), writes nothing
except `<hash>.partial.json`, and keeps any complete trace saved earlier.
`--allow-partial` draws the incomplete flow anyway.

Otherwise it prints the transactions it found and their roles, writes
`.runtime/trace-decoder/<hash>.html` (plus the decoded `.json`) and opens the page with
the **Call flow** and **Sequence** views. Any of the flow's transactions works as
input: the trigger, the settlement batch or a delivery.

More options (same flags as `decode-trace.mjs`, plus):

```sh
node trace-decoder/flow/render-flow.mjs <TX_HASH> --env-file FILE --views all --open
node trace-decoder/flow/render-flow.mjs .runtime/trace-decoder/<hash>.json --env-file FILE --open   # re-render, no RPC calls
  --l1-rpc URL --l1-trace-rpc URL         # e.g. an archive endpoint for this run
  --l1-explorer-url URL --l2-explorer-url URL   # explorer websites for verify links
  --views flow,layers,sequence,timeline|all
```

The older text/JSON CLI is unchanged: `node trace-decoder/decode-trace.mjs <TX_HASH> [--json]`.

## Configuration

The default configuration is the repository root `.env`, even when invoked from
inside `trace-decoder/`. `--env-file FILE` selects another file; `DEVNET_ENV` is
retained as a compatibility override. Explicit relative paths resolve against the
working directory. Settings are resolved in this order:

1. The selected file.
2. Nonempty exported environment variables.
3. CLI flags.

Within one source, the repository names below take precedence over legacy aliases.
Blank values are unset. Unrelated settings and wallet private keys are ignored;
the file is parsed, never sourced or executed. Only allowlisted variable references
such as `$EEZ_UI_L1_RPC_UPSTREAM` are expanded. Shell expressions are rejected.

| Repository setting | Decoder use | Legacy alias |
| --- | --- | --- |
| `EEZ_UI_L1_RPC_UPSTREAM`, `EEZ_UI_L2_RPC_UPSTREAM` | Chain reads | `L1_RPC`, `L2_RPC` |
| `EEZ_UI_L1_FRONT_UPSTREAM`, `EEZ_UI_L2_FRONT_UPSTREAM` | Composer discovery and settlement correlation | `L1_FRONT`, `L2_FRONT` |
| `EEZ_UI_L1_TRACE_RPC_UPSTREAM`, `EEZ_UI_L2_TRACE_RPC_UPSTREAM` | Optional separate trace/archive RPCs; blank uses the corresponding read RPC | `L1_TRACE_RPC`, `L2_TRACE_RPC` |
| `EEZ_REGISTRY_ADDRESS`, `EEZL2_ADDRESS` | L1 and L2 managers, with Composer discovery when available | `ROLLUPS`, `MANAGER_L2` |
| `EEZ_ROLLUP_MANAGER_ADDRESS` | Rollup manager configuration | `EEZ_ROLLUP_MANAGER` |
| `EEZ_UI_L1_EXPLORER_API_URL`, `EEZ_UI_L2_EXPLORER_API_URL` | ABI/name APIs; fall back to the explorer website URLs | `EXPLORER_L1`, `EXPLORER_L2` |
| `EEZ_UI_L1_EXPLORER_URL`, `EEZ_UI_L2_EXPLORER_URL` | Public explorer links, kept separate from API endpoints | `EXPLORER_L1`, `EXPLORER_L2` |
| `EEZ_TRACE_L1_EXPLORER_API_KEY`, `EEZ_TRACE_L2_EXPLORER_API_KEY` | Per-chain explorer credentials | `L1_EXPLORER_API_KEY`, `L2_EXPLORER_API_KEY` |
| `EEZ_TRACE_ETHERSCAN_API_KEY` | Shared Etherscan V2 fallback key | `ETHERSCAN_API_KEY` |

The existing decoder options `EEZ_CORR_RPC`, `L1_EXPLORER_TYPE`,
`L2_EXPLORER_TYPE`, `EXPECTED_L1_CHAIN_ID`, and `EXPECTED_L2_CHAIN_ID` also remain
available. Composer discovery can update environment-supplied manager addresses;
use `--l1-manager` / `--l2-manager` to pin historical deployments.

The API server imports `loadEnvironmentConfig()` from `src/config.mjs` and
passes its result to `decodeCrossChainTrace(config, hash)`. This loader does not
require a transaction or expose unrelated environment values. The CLI uses the
same loader and applies its flags afterward.

Use the shared upstream values from the root [.env.example](../.env.example).
For a host-run CLI, `host.docker.internal` in that template may need a CLI override
to a host-reachable URL such as `http://127.0.0.1:19545`. Endpoints are not rewritten
automatically: container and host networking can differ. Do not put trace-provider
credentials into the browser's `config.json`.

The decoder requests `debug_traceTransaction` with `callTracer` and falls back
to block tracing. Historical transactions need retained historical state. Set a
trace override for Chiado or mainnet when required; no public endpoint is assumed
to support tracing. The trace RPC is also retried for missing historical reads.

Explorer API URLs take priority over website URLs for decoding. Public links use
the website URLs, with credentials and query strings removed by the flow model.
Re-rendering saved JSON loads the same configuration and requires no RPC calls.
Without explorers, EEZ contracts decode from the bundled `src/protocol-abi.json`;
other contracts use validated 4byte.directory matches (`--no-4byte` disables that
lookup, `--no-explorer` both).

## What a decode does

1. Finds the transaction on L1 or L2 and asks the correlation endpoint (`EEZ_CORR_RPC`,
   `L2_FRONT`, `L1_FRONT`, `L2_RPC`, first that answers) which settlement and L2 block range
   belong to its exact receipt block hash, as the E2E runner does. Without correlation
   it searches ±2,000 blocks of the other chain. A failed lookup on a supported
   endpoint is reported as unresolved instead of expanding to a timestamp search.
   Settlement block hashes are independently checked using JSON-RPC batches of up
   to 100 reads; providers rejecting batches fall back to bounded individual reads.
2. Scans the requested block, the settlement block and the settled L2 range for the other
   transactions of the flow (the correlation endpoints return block ranges, not transaction
   lists). In every scanned block only transactions sent to the EEZ manager or carrying an
   EEZ manager event are traced. Range scans reuse `eth_getLogs` results and the
   prefetched blocks instead of fetching every block's receipts. Empty blocks need
   no receipt lookup. If range logs fail, block receipts/logs remain the fallback.
   Full block transactions retain direct manager calls without committed events.
   A fully traced L2 transaction that never touches the EEZ manager follows its exact
   settlement directly, without scanning other jobs in the settled range. Hash
   validation is unchanged; `--thorough` or explicit ranges can extend discovery.
   `--thorough` traces every transaction instead; use it when a wrapper may reach the
   manager without emitting any event (e.g. an eventless wrapper delivery on L2).
3. Builds the call graph, matches crossings and decodes contracts through the explorers.

## How transactions are classified

The decoder collects every transaction in the settled L2 block range. The page keeps
only those connected to the flow by evidence (`classifyTransactions` in `flow/model.mjs`):

- **Trigger**: an application transaction whose cross-chain call is top-level (not nested
  in a delivered call). If an L1 batch entry with `proxyEntryHash == 0` (an L2Tx entry)
  carries the same call, the flow started on L2.
- **Settlement batch / execution table load / L2 delivery**: by the EEZ function called.
- **Not part of this flow**: no cross-chain calls (for example proxy setup), settled in
  the same batch only.

Table loads and deliveries are shown with **EEZ plumbing** ticked; their inspector shows
the decoded execution table. View (static) calls are hidden until **View calls** is ticked.
For a requested L2 transaction without cross-chain calls, its correlated **L1 settlement**
is available directly in the transaction selector. Selecting it reveals the batch's
protocol calls; this settlement relationship does not create a cross-chain call edge.

## Layout

```
show-tx.sh           one-command entry point
decode-trace.mjs     text/JSON CLI and public API (decodeCrossChainTrace)
src/                 decoder: config, engine, rpc, logical (call graph + matching),
                     protocol (+ protocol-abi.json), abi-decoder, explorer
flow/                diagram: model.mjs (trace → call tree, roles), render-flow.mjs (CLI),
                     viewer/ (template.html, viewer.js)
samples/             synthetic example traces (build-samples.mjs)
service/             HTTP API, worker jobs, shared public TypeScript contract
flow/rows.mjs        pure call selection for native React flow and sequence views
tests/               node:test suites and fixtures
```

Update `src/protocol-abi.json` when the EEZ/EEZL2 ABI changes.

## Tests

Configuration checks use only Node's built-in test runner and need no installation:

```sh
node --test trace-decoder/tests/config.test.mjs
```

The default decoder suite requires its declared `ethers` dependency and uses
self-contained fixtures. API lifecycle and React row-selection tests are in
`tests/service.test.mjs` and `tests/rows.test.mjs`; `tests/source-chain.test.mjs`
covers source selection. The dashboard's `tests/trace-details.cjs` provides a
mocked Playwright flow for the React page (requires an already-running dashboard).

```sh
cd trace-decoder && npm test
```

The optional `npm run test:legacy` suite still expects compiled `EEZ` / `EEZL2`
artifacts in repository-level `out/` from the original protocol repository.

`tests/flow-viewer.test.mjs` runs the page script against a stub DOM and checks that
boxes never overlap, every call arrow points right and contract tags are consistent.
Fixtures are synthetic callTracer traces of the E2E topologies, not archive captures.
