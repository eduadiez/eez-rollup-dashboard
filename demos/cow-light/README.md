# EEZ cross-chain CoW Light demo

This directory is the complete, minimal demo stack. It is deliberately
separate from the dashboard's monitor and treasury applications:

```text
deployment/   idempotent deployment helpers and manifests
contracts/    only the two final route contracts used by this demo
backend/      quote API, signed-order queue and settlement status API
solver/       restart-safe inventory-free GPv2 solver
ui/            static wallet UI
config/       L1 Uniswap-V2 token catalog (no secrets)
runtime/      generated queue/logs (gitignored)
```

The solver submits one standard GPv2 settlement to the L2 Composer. Its
pre-interactions transfer the user's L2 WETH to the route, call the canonical
L2→L1 proxy, swap on the configured L1 Uniswap-V2 pair, bridge the purchased
token back and let GPv2 pay the deterministic L2 wrapper. The solver has no
token inventory. The L2 token may have no code before settlement.

## Run locally

```bash
cd demos/cow-light
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a; . .env; set +a
mkdir -p runtime
python3 backend/server.py                 # UI/API on :8788
python3 solver/worker.py                  # separate process
```

Open `http://127.0.0.1:8788/`. The browser only signs the EIP-712 order;
settlement is performed by the worker.

## Deployment

1. Set RPCs, Composer fronts, chain IDs, rollup ID, bridge/manager/settlement
   addresses and `DEPLOYER_PRIVATE_KEY` in a protected environment.
2. Build the two route contracts with Foundry (`forge build --root
   contracts`).
3. Run `python3 deployment/deploy_route.py`; it reuses matching code and
   writes a manifest to `runtime/route-deployment.json`.
4. Deploy GPv2 authentication and settlement using the supplied CoW Swap
   artifacts: `COWSWAP_ARTIFACTS=/path/to/artifacts
   python3 deployment/deploy_cow.py`. The script writes the GPv2 manifest.
5. Verify every newly deployed address on the configured Blockscout verifier
   before using it. Verification is a deployment gate, not an optional
   follow-up.

The route consists of exactly two contracts: `L2UniversalV2Route` on L2 and
`L1UniversalV2BridgeHelper` on L1. The same contracts serve every catalog token.

Both scripts are restart-safe: they query code/configuration first, persist
receipts, and never print or commit private keys.

For systemd, copy `solver/eez-cow-solver.service`, replace `/opt/eez-cow-light`
with this directory, and provide `SOLVER_KEY_FILE` through a protected
EnvironmentFile. Do not put a secret in this repository.

## Checks

```bash
python3 -m py_compile backend/server.py solver/*.py deployment/*.py
forge build --root contracts
```

The deployment scripts are network tools and are not run as part of the web
build. Use canonical Composer and RPC endpoints when validating a settlement;
an execution-RPC receipt alone is not L1-finality.
