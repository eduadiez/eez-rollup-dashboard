# EEZ Rollup UI

Standalone Docker-first web interface for an EEZ rollup network. This repository
contains the UI only; protocol contracts, the node, and Kurtosis topology remain
in the rollup repository.

The source baseline is the earlier
[`eez-association/sync-rollups-poc`](https://github.com/eez-association/sync-rollups-poc)
UI, adapted to the current EEZ RPC and contract interfaces.

The application preserves the original sync-rollups POC screens:

- Dashboard and generic cross-chain calls
- Counter demo
- Bidirectional native-asset/ERC-20 bridge (xDAI on Chiado/Gnosis, ETH on Ethereum)
- Nested flash loan
- Aggregator
- Network monitor (heads, blobs, commitments, and settlement correlations)
- Execution visualizer

The top navigation is **Dashboard → Monitor → Visualizer**. The read-only
[network monitor](src/monitor/README.md) lives at `/monitor/` (legacy `#/monitor`
links still open it) and shares
the dashboard layout, header, footer, and theme. The monitor page mounts inside
the React application, with no embedded page. Its API-only Python collector runs
as an internal Compose service, reached through `/monitor/` on the same origin,
including live WebSockets.

Dashboard combines asset transfers on the left with proxy creation and cross-chain calls
on the right, followed by shared transaction history. Smaller screens stack
Bridge above the proxy workflow. Saved `#/bridge` links open this combined view;
gas settings are collapsed by default and contain the estimate and editable gas
limit. Pending transactions and their confirmations appear in a dismissible
popup; closing pending status does not stop receipt polling. Proxy selection
and call preparation share a panel, while bridge recipients default to the
connected wallet with an optional address editor. Transaction history supports
All, Bridge, and Calls filters, including previously saved bridge records.

Cross-Chain Calls supports L1 → L2 and L2 → L1, including contract and EOA
destinations. Selecting a proxy switches the connected wallet to its source
network; a rejected switch preserves the current selection. Existing L1 proxy
mappings remain in `crossChainProxies`, with L2 proxies stored separately in
`crossChainProxiesL2`. These browser-saved mappings are checked against the
source manager's computed proxy address and `eth_getCode` when selected and
before sending. Confirmed mismatches or missing code clear stale mappings;
RPC errors retain saved data but prevent unverified selection or submission.
Contract names and ABIs come from the destination explorer.
Raw calls accept empty calldata (`0x`) and an optional native-currency value.
Calls use the source Composer's gas estimate or an explicit manual limit, and
poll the source chain for confirmation. Proxy creation and calls show wallet
signing, pending status, confirmation, and errors in the same popup as Bridge.
Closing pending status keeps polling active; the final result reopens the popup
and stays visible until dismissed. The ABI editor has a fixed size.

Transaction history uses network logos for the route, labels transaction links
“L1 tx:” and “L2 tx:”, and shows linked L1/L2 blocks in their own column.
L2 source transactions link to their canonical L1 settlement batch (labeled
“Settlement”). L1 source transactions link to matching L2 incoming call events
within canonical settled blocks. Repeated call hashes with ambiguous origins or
destinations stay unresolved; missing counterparts are retried every 15 seconds.

The top bar shows the deployment name and horizontal network balances beside
the wallet control. Wallet controls and the provider picker use locally served
Rabby and MetaMask logos. Block counters are omitted. On narrow screens, balances
and the compact wallet button share a row below the brand and navigation menu.
Selecting a network also switches the bridge direction after the wallet confirms
the switch; ERC-20 addresses are kept unchanged. Chiado/Gnosis deployments use
xDAI for the native asset on both chains.

Set `EEZ_UI_NETWORK_NAME` in `.env` to the rollup's display name (for example,
`EEZ-X Devnet`). Runtime `networkName` supplies the bridge's L2 labels and the
network name used when adding L2 to a wallet. The bridge shows the amount sent;
gas is paid separately. Saved wallet networks may retain their
previous name and RPC; cross-chain transactions use `/composer/l1` or
`/composer/l2` for their source network.

L1 labels and logos are detected from `eth_chainId`: Ethereum, Gnosis, Chiado,
or Sepolia. Labels do not append “L1.” Override the display name or logo with
`EEZ_UI_L1_NETWORK_NAME` and `EEZ_UI_L1_NETWORK_LOGO_URL` (runtime
`l1NetworkName` / `l1NetworkLogoUrl`). Unknown chains get a neutral icon and
chain ID. These display settings do not change RPCs or transaction routing.

ERC20 bridging supports a searchable token picker alongside manual address
entry. “Known” includes a small Ethereum mainnet catalog of common contract
metadata verified against the [Uniswap default token list](https://github.com/Uniswap/default-token-list).
It is filtered by the source chain; those addresses are never offered on Chiado
or an EEZ rollup. Configure `EEZ_UI_TOKEN_LIST_URL` (runtime `tokenListUrl`) with
a CORS-enabled list in the standard `{ "tokens": [{ "chainId", "address",
"name", "symbol", "decimals" }] }` format to supply deployment-specific tokens.
Use the actual wrapped-token addresses for L2.

“Your tokens” uses the source explorer's Blockscout v2 token-balances API when
available. Set `EEZ_UI_L1_EXPLORER_API_URL` (runtime `l1ExplorerApiUrl`) for L1;
L2 reuses `EEZ_UI_L2_EXPLORER_API_URL`. Without a working indexer, it checks
balances of up to 24 known/recent tokens through the source read RPC, so it
cannot discover every token. Discovery runs only when the picker opens; failures
leave address entry available. “Recent” is stored per source chain; older records
without a chain ID are not offered. Selection still runs the bridge's on-chain
metadata, balance, approval, and gas checks. A token appearing in the list does
not guarantee that the deployed bridge supports it.

One root `.env` and Compose project configure both services; the monitor reuses
`EEZ_UI_L1_RPC_UPSTREAM`, `EEZ_UI_L2_RPC_UPSTREAM`, registry, rollup ID, and explorer
settings. Configure `EEZ_L1_WS_URL` and `EEZ_L2_WS_URL` for immediate node-head
updates; without them, the collector uses HTTP head polling. Settlement and
finality details reconcile separately without delaying live heads. Optional
Beacon, Blobscan, and settlement-policy settings are in `.env.example`.

Feature availability depends on the contracts deployed by the target network.
The counter and bridge require their configured contracts. Flash-loan and
aggregator components remain in the source but are not enabled in navigation.
Transactions require a connected browser wallet such as Rabby or MetaMask.

## Deployment architecture

The application uses two containers in one Compose project:

- `ui` serves the single React application and proxies requests through nginx.
- `monitor` runs the Python telemetry collector and API on the internal network.
  It has no published port or separate frontend.

Keep these services separate for production. Their dependencies, health checks,
logs, and restart lifecycles remain independent. A collector restart temporarily
interrupts monitoring while the dashboard and visualizer remain available.
Both services use the root `.env` and deploy with one `docker compose up -d --build`
command. The existing gateway provides the public HTTPS endpoint.

## Docker Compose

Copy the environment template and point the four upstream values at the network:

```bash
cp .env.example .env
docker compose up --build -d
```

The UI is served at <http://127.0.0.1:8080/dashboard/> by default. Browser RPC requests use
same-origin `/rpc/*` and `/composer/*` routes; nginx proxies those requests to the
configured upstreams, avoiding browser CORS and mixed-content problems.

The Compose defaults target the public-forwarder ports used by the local EEZ
development network. On Linux, `host.docker.internal` is mapped automatically to
the Docker host.

## Independent deployment behind a gateway

The default Compose file publishes the UI on `127.0.0.1:8080`, keeping it
reachable only through the Docker host. Configure `EEZ_UI_BIND` and
`EEZ_UI_PORT` in `.env` if needed. No shared Docker network or override file
is required. Start the UI from this repository with:

```bash
docker compose up -d --build
```

On Linux, a gateway using host networking can proxy to `127.0.0.1:8080` while
the UI retains its own Compose network. The gateway's upstream must match
EEZ_UI_PORT. Each project starts and stops independently. With the UI stopped,
the gateway stays up but UI requests receive an upstream error.

If migrating from the earlier optional shared-network setup, remove
COMPOSE_FILE and EEZ_UI_PUBLIC_NETWORK from your .env and shell environment.
To intentionally expose the UI directly on other interfaces, set
`EEZ_UI_BIND=0.0.0.0`; the default localhost binding is suitable for the gateway.

### Host-loopback RPCs

When the target node binds its RPC and Composer ports to the Docker host's
`127.0.0.1` (as in a host-network Chiado node), set
`COMPOSE_FILE=docker-compose.yml:docker-compose.host-rpc.yml` in this repository's
`.env` and use `http://127.0.0.1:<port>` for the four upstream URLs. Run the usual
`docker compose up -d --build`. This overlay places the UI and monitor in the
host network: the UI listens at `127.0.0.1:8080`, and the monitor listens at
`127.0.0.1:18080`. Both services can then reach the node's loopback RPCs.

### Single-domain path gateway

The default image uses `EEZ_UI_BASE_PATH=/dashboard/`. For a gateway that
publishes the UI at `/dashboard/` and the monitor at `/monitor/`, use a
distinct `EEZ_UI_IMAGE` tag for a reviewed build. Set
`EEZ_UI_BASE_PATH=/` explicitly when rebuilding for an existing root-path
hostname deployment. The gateway strips `/dashboard` before proxying to the
UI and preserves `/monitor`. Its `/monitor/api/*` requests reach the Python
collector through this UI's Nginx proxy. The UI's runtime configuration is
fetched through `/dashboard/config.json`; network RPC and Composer routes stay
at `/rpc/*` and `/composer/*` on the same public hostname.

```bash
docker build -t eez-rollup-ui:dashboard-paths .
```

Set `EEZ_UI_IMAGE=eez-rollup-ui:dashboard-paths` in the private `.env` when
selecting this image for Compose. Keep the existing image tag for rollback.

Set the desired explorer and Composer URLs in the private environment before
cutover. Validate the built image at loopback, including the `/monitor/` page,
dashboard assets, runtime config, and monitor WebSocket. Changing the build
argument requires a new image; recreating a running UI is a separate operation.

## Build and run the image directly

```bash
docker build -t eez-rollup-ui:local .
docker run --rm -p 8080:8080 \
  --add-host host.docker.internal:host-gateway \
  -e EEZ_UI_L1_RPC_UPSTREAM=http://host.docker.internal:19545 \
  -e EEZ_UI_L2_RPC_UPSTREAM=http://host.docker.internal:19546 \
  -e EEZ_UI_L1_FRONT_UPSTREAM=http://host.docker.internal:19547 \
  -e EEZ_UI_L2_FRONT_UPSTREAM=http://host.docker.internal:19548 \
  eez-rollup-ui:local
```

The UI image alone provides Dashboard and Visualizer. For Monitor, use the
root Compose project, which also starts the collector service.

All contract addresses can be supplied as environment variables listed in
`.env.example`. The container also supports the Kurtosis artifact mounts
`/out/deployments.env` and `/demo/demo.env`.

The browser reads `config.json` for runtime addresses and optional demo contract addresses.
It does not request the legacy `/shared/rollup.env` or `/shared/faucet.key` files.

## Kurtosis integration

The rollup repository's `testing/kurtosis/start.sh` builds this checkout by
default when both repositories are siblings:

```text
Development/
├── eez-rollup0-fork/
└── eez-rollup-ui/
```

Override its location with `EEZ_UI_REPO=/path/to/eez-rollup-ui`. To consume a
prebuilt image, set `EEZ_SKIP_UI_BUILD=1` and configure `eez.ui_image` in the
Kurtosis arguments file.

## Local Vite development

With a Kurtosis enclave running:

```bash
KURTOSIS_ENCLAVE=eez-engineer-dev bash scripts/configure-kurtosis.sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8080/dashboard/>. The generated `.runtime/config.json` is ignored by
Git.

## Checks

```bash
npm ci
npm run build
npm run test:visualizer
docker compose config --quiet
# With the combined app running (Node 22+):
node src/monitor/tests/test_proxy.mjs
docker build -t eez-rollup-ui:local .
```

Monitor regression checks and optional telemetry settings are documented in
`src/monitor/README.md`.

## Bridge gas and approvals

Bridge gas is estimated against the source chain's Composer (`/composer/l1`
or `/composer/l2`) using the connected wallet, bridge address, calldata, and
value. The dashboard submits the raw estimate without a buffer or automatic
fallback; an explicit manual gas override takes precedence. Ordinary estimation
errors block submission. Older Composers that report a missing estimation method
or `ExecutionNotInCurrentBlock()` require an explicit manual limit before
submission is enabled. Wrapped bridge tokens burn directly without approval;
native ERC20 tokens still require allowance for the source bridge.

Wallets may apply their own gas policy. Rabby's saved Chiado RPC must use
`https://eez.asuscomm.com/composer/l1` for cross-chain estimation.

Bridge regression checks include:

```bash
node tests/bridge-gas-estimation.test.mjs
node tests/gas-estimation-unfunded.test.mjs
# Against a running UI, with Playwright installed:
node tests/bridge-gas-fees.cjs
node tests/bridge-readiness.cjs
node tests/wallet-startup.cjs
```

## Execution visualizer

Open **Visualizer** or `/dashboard/#/visualizer`. **Live** opens first by default.
**Inspect** accepts a transaction hash, block number, block hash, or `latest` in
one form. Hashes are detected on either chain; numeric blocks and `latest` use
L1 unless L2 is selected. Transaction History's **View execution** action opens
the source transaction in this same view. Failed transactions and contract creations are supported.

The debugger uses mined receipts, EEZ events, posting/loading calldata, and an
optional `debug_traceTransaction` call tracer. Expand execution/static entries
to inspect calls, reentrant frames, expected rolling hashes, return or revert
data, rollup commitments, and ether changes. The timeline aligns linked L1/L2 events on shared rows, with one global
step selector and Previous/Next controls. Each chain retains receipt log order.
Exact call hashes take precedence over replay candidates; ambiguous matches
and nested completions that cross that order remain links across steps. Paired
rows represent related call evidence, not clock-time simultaneity. Expected
entries do not imply successful execution. Traces include nested failures even when reverted receipt logs are
absent. Raw calldata, logs, and receipt JSON remain accessible without tracing.

Cross-chain block links come from `eez_getSettlementByL2Block` and
`eez_getSettledL2RangesByL1Block` on the L2 RPC. For an L1 batch, the L2 lane
loads only the terminal sync block by its indexed hash. Settlement links retain
the complete L2 range. Chain lanes show only calls to known EEZ managers,
decoded EEZ calls, and transactions emitting EEZ events, including calls through
other contracts. Reverted calls to known managers remain visible without logs.
Transaction counts and gas totals cover the displayed EEZ transactions.
Transactions sharing call
hashes appear as candidates; a repeated hash is not a unique execution occurrence.
For work that has not settled, supply the optional counterpart transaction hash.
Missing index or trace methods show a message while preserving available data.

Inspect reads either chain by number or hash using the same EEZ transaction
filter as transaction inspection. Live retains the latest 50 posted
batches from the connected rollup, newest first. The configured registry or
a matching canonical L2 settlement identifies that deployment; unrelated L1
registries are excluded. Rows show linked L1 blocks, L2 ranges, settlement
status, transaction hashes, and the total indexed L2 block count. Selecting
a post loads its L1 receipt and terminal L2 sync block; new blocks preserve the
selected transaction and trace. It polls every
five seconds after each completed refresh, and can be paused. Export JSON saves
the loaded context and traces. Deep links support `tx`, `chain`, `mode`, `block`,
and `counterpart` parameters inside the hash fragment. **Copy inspection link**
also includes the Live `batch`, `selected` transaction and `selectedChain`,
protocol `event` index, inspector `tab`, and focused `call` hash. Live links
restore the selected batch without switching to Inspect. Existing `mode=debug`
and `mode=explorer` links continue to open the combined Inspect view.

The inspector opens **Flow** by default: entry groups containing aligned L1/L2
call requests and reverse return arrows. Nested calls sit inside their parent's
request/return span. Contract and selector labels identify each call; consumed
and completed events stay in Timeline. Entries are associated by rolling hashes
and execution evidence rather than queue indices, which can repeat.

Flow automatically loads relevant transaction traces, with two concurrent
requests and the shared trace cache. Dispatch postorder associates nested
CallResult events; source traces show the bytes returned to the original caller.
Recorded local call ordinals distinguish committed results from earlier rolled-back
attempts. Dispatch matches recompute the protocol call hash, including destination,
rollup IDs and call gas; unresolved repeated hashes stay unlinked. Request and
return arrows share the initiating chain’s color. Vertical execution arrows
connect destination to result through nested calls and resumes. Adjacent calls
by the same contract in the same transaction also connect after the caller
resumes. Waiting callers have no execution bracket; translucent row highlights
sit behind the diagram so they cannot hide connectors. A source-only cached result is
a local loop, never an arrow from an unobserved destination. Leading immediate
L2 entries also show their state commitment on L1, including pure transactions
with no cross-chain calls. Applied updates require a unique rolling-hash
completion and matching root-update receipt logs; skipped, unconfirmed, and
mismatched updates retain their status. Other empty entry groups are collapsed.
The schematic does not imply cross-chain wall-clock timing. Missing returns
are explicitly unavailable. Select a row for inline transaction links,
trace/event details, return evidence, or previous/new roots. Clicking any row
while details are open dismisses them. L1 details remain on the left.
One global step control navigates requests, returns, and immediate state updates.

**Timeline** retains the complete recorded events and transaction boundaries.
**Calls**, **Entries**, and **Raw** provide traces, plan comparisons, and source
data. Share links restore the chosen view and original receipt event index.
Replay candidates can connect differing trigger hashes through an associated
execution plan, source address, calldata, value, and a recorded call result or
unique rolling-hash completion. They do not prove destination or global timing.
Entries compares expected outcomes, rolling hashes,
and return/revert bytes with uniquely associated recorded evidence. Missing
logs or return bytes remain **Missing evidence**, rather than a mismatch.
Static execution requires more evidence than persistent receipt logs provide.
Direct incoming entrypoint traces can establish returned or reverted bytes;
a successful posting transaction alone does not prove every planned entry ran.

Calls caches traces while switching transactions and batches. Protocol ABIs
are local; verified contract names/functions/arguments/results are fetched from
the configured explorers with bounded concurrency and a short cache. Unknown
contracts keep raw calldata/results. **Jump to failure** skips reverts handled
by successful enclosing calls and directly verified expected root reverts.

Batch search covers transaction hashes, block numbers (including the settled
L2 range), registry addresses, and inspected contracts/call hashes. Settlement
and execution filters distinguish indexed/finalized/pending/noncanonical
batches, observed cross-chain calls, reverted transactions, and skipped entries.
Live automatically loads entry details for the latest 50 batches in the
background, using two concurrent inspections and retaining the selected batch
and timeline step. **Pause** stops new inspections and **Resume** continues.
Unavailable inspections retry after 30 seconds; **Retry unavailable batches**
retries immediately. Coverage is explicit; pending or unavailable batches do
not imply successful execution. Only the terminal L2 sync block is loaded for
an L1 batch, so these checks describe the
loaded evidence, not every transaction throughout its L2 settlement range.
The batch list collapses and resizes, and the chain lanes remain visible beside
the inspector on desktop.

The debugger has a separate ABI snapshot for EEZ/EEZL2, including deployed
pre-cursor L2 static tables and current cursor tables. It discovers unconfigured
registry emitters from successful batch calldata/events (including forwarding
contracts), and L2 managers from their execution events. Explicit runtime or URL
contract addresses take precedence. To regenerate the snapshot from compiled
protocol artifacts:

```bash
python3 scripts/generate-visualizer-abi.py ../eez-core-protocol
```

For local Vite development, run the Python monitor on port `18080` as described
there. Vite proxies `/monitor/` to that port; `EEZ_MONITOR_UPSTREAM` overrides the
development target. The monitor collector needs its Python dependencies installed.

When migrating an existing standalone monitor, copy optional settings from
`src/monitor/.env` into the root `.env`, use the root UI RPC/explorer
variable names, and stop the old monitor Compose project before starting the
combined project. The old monitor port is no longer published. Gateways only
need to forward the UI port, with WebSocket upgrades enabled.

### Local explorer archive for the blob decoder

When the `eez-explorers` stack is running, set
`COMPOSE_FILE=docker-compose.yml:docker-compose.explorers.yml` and
`EEZ_BLOBSCAN_API_URL=http://blobscan-api:3001` in `.env`, then run
`docker compose up -d --build ui monitor`. The optional overlay joins only the
monitor to the existing explorer network; Blobscan API access stays internal.
Standalone deployments can continue using the main Compose file and another
configured archive URL.

The decoder supports historical tags 0–2 and tag 3/profile 1 from the derivable
operations network. Tag 3 shows sparse records and retained full blocks; it does
not reconstruct omitted headers. This is structural inspection, not transaction
signature/schema validation, KZG authentication, block hash validation, or execution
replay. No database migration is needed. Deploy the monitor and UI together; an
older monitor rejects tag 3 and an older UI lacks its sparse-block explanation.
