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
- Bidirectional ETH/ERC-20 bridge
- Nested flash loan
- Aggregator
- Faucet
- Network monitor (heads, blobs, commitments, and settlement correlations)
- Execution visualizer

The top navigation is **Dashboard → Monitor → Visualizer**. The read-only
[network monitor](src/monitor/README.md) lives at `/monitor/` (legacy `#/monitor`
links still open it) and shares
the dashboard layout, header, footer, and theme. The monitor page mounts inside
the React application, with no embedded page. Its API-only Python collector runs
as an internal Compose service, reached through `/monitor/` on the same origin,
including live WebSockets.
One root `.env` and Compose project configure both services; the monitor reuses
`EEZ_UI_L1_RPC_UPSTREAM`, `EEZ_UI_L2_RPC_UPSTREAM`, registry, rollup ID, and explorer
settings. Configure `EEZ_L1_WS_URL` and `EEZ_L2_WS_URL` for immediate node-head
updates; without them, the collector uses HTTP head polling. Settlement and
finality details reconcile separately without delaying live heads. Optional
Beacon, Blobscan, and settlement-policy settings are in `.env.example`.

Feature availability depends on the contracts deployed by the target network.
The current defensive-checks devnet supports the counter, bridge, faucet, and
forward flash-loan flows. Its reverse-flash and aggregator contracts are not yet
deployed, so those screens are present but not operational.

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

The UI is served at <http://127.0.0.1:8080> by default. Browser RPC requests use
same-origin `/rpc/*` and `/composer/*` routes; nginx proxies those requests to the
configured upstreams, avoiding browser CORS and mixed-content problems.

The Compose defaults target the public-forwarder ports used by the local EEZ
development network. On Linux, `host.docker.internal` is mapped automatically to
the Docker host.

Never put a production or valuable private key in `.env`. The optional demo key
is delivered to every browser through `config.json` and is intended only for a
disposable private devnet.

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

### Single-domain path gateway

For a gateway that publishes the UI at `/dashboard/` and the monitor at
`/monitor/`, build a separate image with `EEZ_UI_BASE_PATH=/dashboard/` and a
distinct `EEZ_UI_IMAGE` tag. The default `/` build remains for existing
hostname deployments. The gateway strips `/dashboard` before proxying to the
UI and preserves `/monitor`. Its `/monitor/api/*` requests reach the Python
collector through this UI's Nginx proxy. The UI's runtime configuration is
fetched through `/dashboard/config.json`; network RPC and Composer routes stay
at `/rpc/*` and `/composer/*` on the same public hostname.

```bash
docker build --build-arg EEZ_UI_BASE_PATH=/dashboard/ \
  -t eez-rollup-ui:dashboard-paths .
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

Open <http://127.0.0.1:8080>. The generated `.runtime/config.json` is ignored by
Git.

## Checks

```bash
npm ci
npm run build
docker compose config --quiet
# With the combined app running (Node 22+):
node src/monitor/tests/test_proxy.mjs
docker build -t eez-rollup-ui:local .
```

Monitor regression checks and optional telemetry settings are documented in
`src/monitor/README.md`.

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
