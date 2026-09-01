# EEZ Network Observatory

A standalone, read-only dashboard for an EEZ development network. It monitors:

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
  public URLs.

It does not contain a wallet, private key, transaction relay, or unrestricted
JSON-RPC proxy. The dashboard is operational telemetry, not a replacement for
the blob verifier or the protocol E2E suite.

## Run with a Kurtosis network

Copy the template and set the public registry address from the network's
`eez-deployments/deployments.env` artifact:

```bash
cp network-observatory/.env.example network-observatory/.env
docker compose --env-file network-observatory/.env \
  -f network-observatory/docker-compose.yml up -d --build
```

The direct host-only URL is `http://127.0.0.1:18080`. The container joins the
Kurtosis network named by `EEZ_DOCKER_NETWORK` and uses service DNS names, so
host port remapping does not affect it.

For the current public gateway, `/monitor/` is routed to `eez-monitor:8080`:

```text
https://eez.asuscomm.com/monitor/
https://eez.asuscomm.com:4443/  # Blobscan
https://eez.asuscomm.com:4444/  # L1 Blockscout
https://eez.asuscomm.com:4445/  # L2 Blockscout
https://eez.asuscomm.com/composer/l1  # L1-origin Composer RPC (chain 7331)
https://eez.asuscomm.com/composer/l2  # L2-origin Composer RPC (chain 6290)
```

The explorer applications use separate origins because each application owns
root-relative routes and static assets.

## Validate

```bash
python3 -m unittest discover -s network-observatory/tests -v
node network-observatory/tests/test_app.mjs
docker compose --env-file network-observatory/.env \
  -f network-observatory/docker-compose.yml ps
curl -fsS http://127.0.0.1:18080/api/health
curl -fsS http://127.0.0.1:18080/api/snapshot | jq .
```

The snapshot collector is cached for `EEZ_REFRESH_SECONDS`, scans at most 32
recent blocks, and applies an upstream timeout. A failed optional component is
reported as a warning while healthy chain data remains visible.

## APIs

- `GET /api/health`: process liveness only.
- `GET /api/snapshot`: bounded network telemetry snapshot.
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
