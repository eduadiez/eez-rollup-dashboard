# EEZ Monitor Dashboard

A standalone, read-only dashboard for an EEZ network, configured entirely with
external HTTP(S) URLs and public contract metadata. It can run on a separate host
without a rollup checkout, deployment artifacts, Kurtosis, or a shared Docker
network. It monitors:

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

Copy the template, then edit `network-observatory/.env` to set `EEZ_L1_RPC_URL`
and `EEZ_L2_RPC_URL` to the network's externally reachable read RPC endpoints:

```bash
cp network-observatory/.env.example network-observatory/.env
```

The two RPC URLs are required; startup reports missing or invalid values.
Optional services and links can be added independently:

| Variables | Purpose |
| --- | --- |
| `EEZ_L1_RPC_URL`, `EEZ_L2_RPC_URL` | Required Ethereum JSON-RPC read endpoints. |
| `EEZ_BEACON_URL` | Optional Beacon REST API root for blob-sidecar checks. |
| `EEZ_BLOBSCAN_API_URL` | Optional Blobscan API root for blob decoding and historical lookup by versioned hash. |
| `EEZ_REGISTRY_ADDRESS`, `EEZ_ROLLUP_ID` | Public contract metadata for EEZ commitment and settlement checks; the rollup ID defaults to `1`. |
| `EEZ_L1_EXPLORER_URL`, `EEZ_L2_EXPLORER_URL`, `EEZ_BLOBSCAN_URL` | Optional explorer frontend roots used for links. |
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

Start the monitor after filling in the required values:

```bash
docker compose --env-file network-observatory/.env \
  -f network-observatory/docker-compose.yml up -d --build
```

Open `http://127.0.0.1:18080`. Compose creates its own network; no existing Docker
network or gateway is required. Set `EEZ_DASHBOARD_BIND=0.0.0.0` to make the
published port accessible from other hosts, or put it behind your own HTTPS
reverse proxy. To serve it under a prefix such as `/monitor/`, have the proxy
strip that prefix before forwarding requests to the monitor.

For a direct run without Docker, use Python 3.10 or newer and install the pinned
WebSocket dependency (already included in the Docker image):

```bash
python3 -m pip install -r network-observatory/requirements.txt
EEZ_L1_RPC_URL=https://l1.example.com/rpc \
EEZ_L2_RPC_URL=https://l2.example.com/rpc \
EEZ_DASHBOARD_HOST=127.0.0.1 \
python3 network-observatory/app/server.py
```

Replace the example URLs with your endpoints, then open `http://127.0.0.1:8080`.
The direct Python process reads environment variables; `.env` is loaded by
Compose only. Set `EEZ_DASHBOARD_PORT` to change the Python listening port.

For an existing installation, replace internal service names in `.env` with
external URLs. `EEZ_DOCKER_NETWORK` is no longer used, and the container no longer
has the fixed name `eez-monitor`. Point any existing reverse proxy at the
monitor's published host and port.

## Validate

```bash
python3 -m unittest discover -s network-observatory/tests -v
node network-observatory/tests/test_app.mjs
node network-observatory/tests/test_live_app.mjs
docker compose --env-file network-observatory/.env \
  -f network-observatory/docker-compose.yml config --quiet
docker compose --env-file network-observatory/.env \
  -f network-observatory/docker-compose.yml ps
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18080/api/snapshot | jq .
```

The snapshot collector is cached for `EEZ_REFRESH_SECONDS`, scans at most 32
recent blocks per chain, and applies an upstream timeout. Settlement history
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

All viewers share one collection loop. A head notification requests a fresh
canonical RPC snapshot, coalesced to at most one collection per
`EEZ_LIVE_UPDATE_SECONDS` (default 1; must not exceed `EEZ_REFRESH_SECONDS`).
Notifications do not directly alter canonical history. Full snapshots preserve
same-height reorgs, rollbacks, and multiple settlements in an L1 block. Periodic
reconciliation at `EEZ_REFRESH_SECONDS` also picks up delayed receipts, indexes,
and safe/finalized changes without another head notification.

Unconfigured or disconnected node WebSockets temporarily use lightweight HTTP
head checks. Configured sockets reconnect with bounded backoff and trigger a full
reconciliation. The public Chiado deployment configures both WSS endpoints; HTTP
head checks are its outage fallback. Snapshot frames report each source's actual
`websocket`, `polling`, or `unavailable` status in `liveUpdates.sources`.

The browser shows **Live updates** after receiving a snapshot, reconnects after
disconnects or a stalled feed, and uses the existing HTTP snapshot API while
reconnecting. A delayed fallback response cannot overwrite a newer pushed
snapshot. It retains searches and decoded transaction details across updates.
The feed permits 16 simultaneous viewers; additional viewers use HTTP polling.
Slow viewers receive the latest snapshot without an unbounded replay queue.
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
`wss://eez.asuscomm.com/monitor/api/live` for browser snapshots. TLS terminates at
the existing gateway; the node WebSocket ports remain bound to loopback. No
composer submission endpoint is used by the live feed.

The public deployment at `https://eez.asuscomm.com/monitor/` uses the existing
prefix-stripping gateway. Assets, API calls, search, decoding and correlation
requests remain relative to `/monitor/`. The service has no Docker socket or
runtime access to the composer; preserve its read-only container settings when
updating an existing installation. Recreating a devnet requires reconnecting
the monitor/gateway to the recreated network and clearing previous-chain caches.

## APIs

- `GET /api/health`: process liveness only.
- `GET /api/snapshot`: bounded network telemetry snapshot.
- `GET /api/live` with a WebSocket upgrade: read-only snapshot feed. Frames contain
  `type` (`snapshot` or `unavailable`), connection-independent `sequence`, and
  `snapshot`. Reconnects receive current full state; sequence numbers are local
  to one monitor process. Client application messages are rejected.
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
