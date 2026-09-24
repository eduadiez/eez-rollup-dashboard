# EEZ Monitor Dashboard

The read-only **Monitor** tab in the EEZ rollup dashboard. The Python collector
and its telemetry frontend are kept here as one module; deployment is managed
by the repository's root `docker-compose.yml` and `.env`.

This module contains the React view (`NetworkMonitorView.tsx`), Python collector
(`server.py`, `live.py`, `blob_decoder.py`), scoped telemetry renderer (`client.js`) and styles (`monitor.css`), and
regression tests (`tests/`). Brand assets are shared with the dashboard in `src/styles/brand/`.
The monitor renders in the React application; there is no iframe or standalone
HTML page. The Python service serves `/api/*` only.
The `docs/` directory retains historical verification reports, including paths
and hashes recorded before this directory was reorganized.

It monitors:

- L1 and L2 latest, safe, and finalized heads;
- recent blocks, transaction counts, gas use, sync state, and peers;
- EIP-4844 type-3 transactions, versioned hashes, receipts, and blob gas;
- immediate client-side filtering of the recent settlement window plus bounded,
  server-side historical lookup by L1 block, L2 block, posting transaction hash,
  or blob versioned hash;
- Beacon blob-sidecar availability and KZG commitments;
- EEZ registry block-hash commitment resolution against the canonical L2 chain,
  including whether the committed block has reached the safe head;
- exact L2-to-L1 and L1-to-L2 settlement correlations through the node RPC.
- contextual deep links from heads, commitments, block numbers and hashes,
  settlement transactions, correlation results, and every versioned blob hash
  to the corresponding L1/L2 Blockscout or Blobscan page;
- strict, server-side decoding of the native EEZ semantic blob envelope
  and its chain-operation payload, including self-contained L2 block summaries;
- decoded cross-chain transaction boundaries, calls, static calls, exact result
  kinds, snapshot/revert regions, and context-derived chain routes, grouped as
  one expandable message table per
  `InitiateCrossChainTransaction … FinishCrossChainTransaction` bracket;
- an expandable ChainOperation/semantic guide and a per-result byte-layout explanation
  covering field-element packing, message framing, payload tags, and the
  structural-versus-cryptographic evidence boundary;
- a top-of-page Composer RPC bar that distinguishes the L1→L2 and L2→L1
  transaction fronts, reports their source chain IDs, and provides copyable
  public URLs;
- configured settlement rules, progress from the canonical L1 commitment to the
  general L2-block threshold, and the last canonical post;
- a separate bounded settlement-history window that keeps infrequent posts
  visible between five-minute settlements, including multiple posts in one L1
  block;
- actual posting-transaction execution and blob fees, calculated from receipts
  with integer arithmetic and displayed in the configured native currency;
- full Beacon blob availability on Fulu/PeerDAS networks, with legacy sidecar
  support for older Beacon APIs.

It does not contain a wallet, private key, transaction relay, or unrestricted
JSON-RPC proxy. The dashboard is operational telemetry, not a replacement for
the blob verifier or the protocol E2E suite.

## Run against external endpoints

Copy the root `.env.example` to `.env` and configure `EEZ_UI_L1_RPC_UPSTREAM`
and `EEZ_UI_L2_RPC_UPSTREAM`. Compose shares these read endpoints with the monitor.
Its internal Python environment uses `EEZ_L1_RPC_URL` and `EEZ_L2_RPC_URL`.
Optional services and links can be added independently:

| Variables | Purpose |
| --- | --- |
| `EEZ_L1_RPC_URL`, `EEZ_L2_RPC_URL` | Required Ethereum JSON-RPC read endpoints. |
| `EEZ_BEACON_URL` | Optional Beacon REST API root for blob-sidecar checks. |
| `EEZ_BLOBSCAN_API_URL` | Optional Blobscan API root for blob decoding and historical lookup by versioned hash. |
| `EEZ_REGISTRY_ADDRESS`, `EEZ_ROLLUP_ID` | Public contract metadata for EEZ commitment and settlement checks; the rollup ID defaults to `1`. |
| `EEZ_UI_L1_EXPLORER_URL`, `EEZ_UI_L2_EXPLORER_URL`, `EEZ_BLOBSCAN_URL` | Optional explorer frontend roots used for links. |
| `EEZ_L1_COMPOSER_RPC_URL`, `EEZ_L2_COMPOSER_RPC_URL` | Optional public transaction fronts displayed for copying. |
| `EEZ_SETTLEMENT_LOOKBACK_BLOCKS` | Registry log history window, default `512` L1 blocks, allowed `32`–`4096`. Independent of the block cards. |
| `EEZ_RECENT_SETTLEMENTS` | Maximum displayed posts from that history, default `12`, allowed `2`–`64`. |
| `EEZ_L1_NATIVE_CURRENCY` | Native 18-decimal receipt currency, default `ETH`; configure `XDAI` for Gnosis/Chiado. |

Use ordinary read RPC endpoints for collection. Exact settlement correlations
also need the L2 endpoint to expose `eez_getSettlementByL2Block` and
`eez_getSettledL2RangesByL1Block`. Unavailable optional RPC methods do not prevent
head and block monitoring.

Recent settlement history additionally requires `eth_getLogs` for the configured
registry. Its window and number of hydrated transactions are bounded. The API
returns the searched L1 range and whether older posts were omitted; a failed
history query is reported as unavailable and falls back to the recent block
view. Receipt inclusion and the pinned L1 head are checked before reporting
history. Duplicate events do not duplicate transactions, and separate posting
transactions in the same L1 block are retained with a zero-second interval.

## Display the node's settlement policy

The monitor cannot read the composer's process configuration through ordinary
Ethereum RPC. Copy the actual node values into the monitor environment. This
only describes the configured rules; it does not change or schedule settlement.
If omitted, the monitor explicitly shows that the policy was not supplied.

For the devnet that consolidates empty history every five minutes and settles
ordinary included transactions at the next opportunity:

```dotenv
EEZ_SETTLEMENT_POLICY_ENABLED=true
EEZ_SETTLEMENT_PURE_L2_MODE=always
EEZ_SETTLEMENT_MAX_UNSETTLED_L2_BLOCKS=150
EEZ_SETTLEMENT_BLOB_FULLNESS_BPS=off
EEZ_L2_BLOCK_TIME_MS=2000
```

`EEZ_SETTLEMENT_PURE_L2_MODE` accepts `always` or `interval`; interval mode
requires a positive `EEZ_SETTLEMENT_PURE_L2_INTERVAL_MS`. The general block
threshold must be positive. Fullness is `off` or `1`–`10000` basis points over
all permitted blobs. An interval supplied with `always` is validated but
inactive. Explicitly disabled policy cannot have active policy options.
Invalid settings fail at startup. Blank optional Compose values count as unset.

The five-minute label is derived from 150 × 2 seconds. Progress uses the applied
canonical L1 commitment and latest L2 height; reaching the general threshold
means inclusion is due, not that it already happened. Transaction activity can
settle earlier. With no L2 cadence supplied, only block progress is shown. A
missing/noncanonical commitment or stale snapshot cannot produce an active
countdown. No settlement reason is inferred from an empty recent block window.

The displayed post cost is `gasUsed × effectiveGasPrice` plus
`blobGasUsed × blobGasPrice`. These values are decimal strings in the API to
preserve precision. Missing receipt fields remain unknown. Costs cover the
posting transaction; companion transactions and builder payments are separate.
They are observed native fees, not a mainnet price estimate or monthly forecast.

All upstream requests run on the monitor server, so URLs must be reachable from
that host or container. Browser CORS access to those services is unnecessary.
Upstream URLs may include a path prefix and query parameters such as an API key;
these URLs remain server-side. Explorer and Composer URLs are public, cannot
contain query parameters or user information, and must be reachable by the
browser. The Blobscan API URL is configured separately from its frontend URL.

Start the dashboard and collector together from the repository root:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8080/#/monitor`. The collector has no published port;
nginx forwards `/monitor/` requests and WebSocket upgrades to the internal service.

For a direct run without Docker, use Python 3.10 or newer and install the pinned
WebSocket dependency (already included in the Docker image):

```bash
python3 -m pip install -r src/monitor/requirements.txt
EEZ_L1_RPC_URL=https://l1.example.com/rpc \
EEZ_L2_RPC_URL=https://l2.example.com/rpc \
EEZ_DASHBOARD_HOST=127.0.0.1 \
EEZ_DASHBOARD_PORT=18080 \
python3 src/monitor/server.py
```

Replace the example URLs with your endpoints, then start Vite and open `http://127.0.0.1:8080/#/monitor`.
The direct Python process reads environment variables; `.env` is loaded by
Compose only. Set `EEZ_DASHBOARD_PORT` to change the Python listening port.

## Validate

```bash
python3 -m unittest discover -s src/monitor/tests -v
node src/monitor/tests/test_app.mjs
node src/monitor/tests/test_live_app.mjs
docker compose config --quiet
docker compose ps
curl -fsS http://127.0.0.1:8080/monitor/api/health
curl -fsS http://127.0.0.1:8080/monitor/api/snapshot | jq .
```

The snapshot collector is cached for `EEZ_REFRESH_SECONDS`, keeps 20 recent L1 blocks and 100 recent L2 blocks by default
(`EEZ_L1_RECENT_BLOCKS` / `EEZ_L2_RECENT_BLOCKS`, each bounded to 128), and applies an upstream timeout. Settlement history
uses its separately configured registry log window. Successful Beacon
availability results are cached by L1 block hash with a bounded cache; missing
data is retried on the next collection. A failed optional component is
reported as a warning while healthy chain data remains visible. Blank Beacon
and Blobscan API URLs disable their integrations without contacting an assumed
internal service.

Snapshot delivery and chain progress are reported separately. Each chain card
shows its latest block age. A head older than `EEZ_HEAD_DELAY_WARNING_SECONDS`
(default 30 seconds; valid range 1–3600) produces a **head delayed** warning and
sets snapshot `healthy` to false, even when RPC calls and live updates succeed.
`chains.*.healthy` continues to indicate RPC reachability; `chains.*.freshness`
reports block age, warning threshold, and `current`, `delayed`, or `unavailable`
status. The warning clears when a fresh block arrives. This threshold monitors
block production and does not change settlement frequency. A fresh snapshot
with delayed heads is distinct from a cached snapshot marked `stale`.

### Live updates

The browser opens one WebSocket at `api/live`, relative to its monitor URL.
HTTPS deployments use WSS automatically. Configure `EEZ_L1_WS_URL` and
`EEZ_L2_WS_URL` with the nodes' WS(S) endpoints to subscribe to `newHeads` on both
chains. Each connection checks its chain ID against the corresponding HTTP RPC
before subscribing. The URLs and any API query keys stay on the server.

Node notifications take a separate, immediate path to the browser. A validated
`newHeads` notification publishes the chain's header without waiting for RPC
history, receipts, Beacon sidecars, or the detail cache lock. Transaction and blob
counts remain unknown until block bodies are fetched; a header never implies an
empty block. Separate workers fetch a bounded recent block window per chain,
following parent hashes and reusing previously hydrated ancestors. These workers
fill transaction counts and missing rows independently of settlement collection.
A new head replaces the pending target rather than adding to a work queue.

All viewers share a separate details worker. L1 heads, reconnects, and detected
reorgs request reconciliation, limited by `EEZ_LIVE_UPDATE_SECONDS` (default 1).
Normal contiguous L2 heads do not trigger full collection. Periodic reconciliation
at `EEZ_REFRESH_SECONDS` updates safe/finalized heads, settlement history, delayed
receipts, and indexing results. These intervals do not throttle WebSocket head
delivery. New head events win over details that were already being collected.
Detected reorgs invalidate dependent canonical claims until reconciliation verifies
them. Missing headers trigger verification without being treated as proof of a reorg.

Configure both `EEZ_L1_WS_URL` and `EEZ_L2_WS_URL` for event-driven updates.
Without them, or during a subscription failure, head detection uses HTTP polling
at `EEZ_LIVE_UPDATE_SECONDS`. Configured sockets reconnect with bounded backoff
and verify the chain ID before subscribing. Detail frames report each source's
actual `websocket`, `polling`, or `unavailable` status in `liveUpdates.sources`.

The browser reconnects after disconnects or a stalled feed and uses the HTTP
snapshot API as a fallback. Searches and decoded results survive updates. The
feed keeps one full detail record, one latest header, and one bounded hydrated
block window per chain, so slow viewers
do not accumulate an event backlog. Reconnects receive current details and heads.
Collection and head watching pause when the last live viewer disconnects.

Reverse proxies must forward WebSocket upgrades to the monitor on its existing
HTTP port. For nginx, add this map at HTTP scope and these directives to the
existing monitor proxy location:

```nginx
map $http_upgrade $eez_connection_upgrade {
    default upgrade;
    "" close;
}

# Inside location /monitor/ (with its existing proxy_pass):
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $eez_connection_upgrade;
proxy_read_timeout 60s;
```

The public deployment uses `wss://eez.asuscomm.com/ws/l1` and
`wss://eez.asuscomm.com/ws/l2` for node subscriptions, and
`wss://eez.asuscomm.com/monitor/api/live` for browser updates. TLS terminates at
the existing gateway; the node WebSocket ports remain bound to loopback. No
composer submission endpoint is used by the live feed.

The monitor is part of the dashboard at `https://eez.asuscomm.com/#/monitor`.
The dashboard serves its assets, and monitor API requests use `/monitor/api/`
through the existing gateway. The service has no Docker socket or runtime access
to the composer; preserve its read-only container settings when updating an
existing installation. Recreating a devnet requires reconnecting
the monitor/gateway to the recreated network and clearing previous-chain caches.

When detail collection falls behind, the browser checks continuity using a bounded
history of block hashes and parent hashes. Missed headers retain last verified
data with a verification notice; they are not treated as proof of a reorg.
Same-height replacements, rollbacks, and conflicting parents invalidate dependent
settlement and finality claims until a later canonical collection succeeds.
Transaction counts remain attached to their block hash. Partial RPC failures
retain available prior data with an error notice, and the backend rejects block
windows assembled across different branches during collection.

## APIs

- `GET /api/health`: process liveness only.
- `GET /api/snapshot`: bounded network telemetry snapshot.
- `GET /api/live` with a WebSocket upgrade: read-only event feed. `heads` frames
  contain the latest header per chain, its observation time, and sequence number.
  Frames also include `blocks`, the latest hash-linked hydrated window per chain;
  block-detail updates may arrive without changing the head sequence.
  `snapshot` frames include reconciled details, latest headers, and
  `collectionStartedSequence`, which prevents older details overriding newer heads.
  `unavailable` frames report collection failures while head delivery continues.
  Sequence numbers are local to one process. Client application messages are rejected.
- `GET /api/settlement-search?q=L1:42`: exact historical settlement lookup.
- `GET /api/settlement-search?q=L2:250`: exact lookup through the canonical
  L2-to-L1 index. An unscoped number tries both chains; a full 32-byte hash is
  resolved as a block, posting transaction, or blob versioned hash.
- `GET /api/correlation?direction=l2-to-l1&block=0x2a`: exact settlement lookup.
- `GET /api/correlation?direction=l1-to-l2&block=0x10`: exact L2 ranges lookup.
- `GET /api/blob-decode?tx=0x...`: validate and structurally decode an EEZ
  type-3 settlement transaction using canonical L1 ordering and Blobscan data.

Correlation and settlement-search selectors accept a decimal block number,
Ethereum hex quantity, or a full hash. Prefixes such as `L1:` and `L2:` remove
number/hash ambiguity. The blob decoder only accepts a canonical type-3 transaction
targeting the configured registry, requires its Blobscan blob set to match L1,
and enforces the current rollup ID and codec bounds. Arbitrary JSON-RPC methods
are intentionally not exposed.

## Security and evidence boundary

The service runs as an unprivileged user with a read-only filesystem, all Linux
capabilities dropped, and a fixed Content Security Policy. RPC endpoints remain
server-side. Because the dashboard summarizes upstream responses, green status
means those live observations agree; cryptographic DA verification remains the
responsibility of `eez-l1`'s verifier and the protocol E2E evidence scripts. A
successful dashboard decode is structural observability evidence, not an
independent KZG proof or STF validation.

Beacon availability means complete bytes were returned for the slot with a
count matching canonical L1 blob gas. The monitor tries the Fulu full-blob API
first and falls back to sidecars only when that endpoint is unsupported; a
timeout or malformed response is not hidden by fallback. The availability check
does not recompute KZG commitments. Historical protocol test/audit results are
not presented as a continuously running correctness proof.

The recent-block tables scroll vertically with sticky column headings. The subtle sync-row tint identifies an L1-anchored sync slot using `EEZ_L1_BLOCK_TIME_MS` and the
observed L1 timestamp phase; it does not imply settlement or nonempty transactions.
Leave the cadence blank to disable classification on an unconfigured network.
The local Chiado deployment uses 5000 ms. Collected block windows reuse prior
blocks only while parent hashes connect to the checked canonical head; a mismatch
clears that cache for reconciliation.

The feature/events deployment uses `BatchPosted(bytes32,uint64[])` from protocol
`820e50f749f63165be6a5797d4c5fe52cbbbbe34`. Its event filter is incompatible
with the previous registry; use the retained old monitor image when restoring
the old network.
