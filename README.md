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
- Execution visualizer

Feature availability depends on the contracts deployed by the target network.
The current defensive-checks devnet supports the counter, bridge, faucet, and
forward flash-loan flows. Its reverse-flash and aggregator contracts are not yet
deployed, so those screens are present but not operational.

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
docker build -t eez-rollup-ui:local .
```
