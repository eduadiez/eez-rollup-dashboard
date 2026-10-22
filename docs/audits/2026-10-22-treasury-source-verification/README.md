# Treasury source verification — 2026-10-22

Status: partially completed. All 103 discovered treasury and supporting contract
addresses were checked. **86 have an exact source match** on Blockscout or
Sourcify. Twelve Chiado addresses have only partial explorer verification; five
EEZ-X addresses remain unverified. No on-chain transaction was broadcast.

| Network | Addresses checked | Exact match on either service | Partial match only | Unverified |
| --- | ---: | ---: | ---: | ---: |
| Chiado, 10200 | 52 | 40 | 12 | 0 |
| EEZ-X devnet, 906969 | 51 | 46 | 0 | 5 |

The [inventory](inventory.json) includes every address, explorer link, discovery
origin, original transactions, before/after verification flags, compiler input
identity, and Sourcify result where applicable. This covers the dashboard
wallet's treasury deployments, including earlier setups, shared infrastructure,
configured protocol contracts and referenced proxy implementations. It does not
claim to enumerate every arbitrary contract on either network or deployments
made by unrelated wallets.

## Explorer visibility

EEZ-X's explorer fully verifies 46 addresses, including the current mirror Safes,
Safe implementations/factories, official allowance modules, current split
policies and upgrade contract, setup executors, token and both bridge variants.

Chiado's explorer currently reports 11 full and 23 partial verifications.
Sourcify independently verified 34 addresses with exact runtime matches, bringing
the union of exact matches to 40. Eighteen exact Sourcify results are still absent
from Chiado's explorer. Source verification on Sourcify must not be reported as a
successful Blockscout import. Creation verification is recorded separately:
Sourcify could not obtain creation traces for several internally created
contracts, despite verifying their runtime and metadata exactly.

Examples:

- [Current EEZ-X mirror Safe](https://eez.asuscomm.com/explorer/address/0x68B338bF6EdCE9B8956F6A3e1A2a2935da1434E4?tab=contract).
- [Current split policy](https://eez.asuscomm.com/explorer/address/0x2bEed6DC9c639d4Fd823ddD007837f6263ecCEb6?tab=contract).
- [Shared EEZ-X treasury bridge](https://eez.asuscomm.com/explorer/address/0x976BF7AEB2b24291970965C8035687a1926a0B35?tab=contract).
- [Shared Chiado treasury bridge, exact Sourcify match](https://repo.sourcify.dev/10200/0x7F772f334b9a97C514A89FfD004AFcEAF5DDF789).
- [Chiado faucet, exact Sourcify match](https://repo.sourcify.dev/10200/0x95518955399720E275F25EFFd1E1a66AA4CAB5f5).

## Remaining source provenance

These five EEZ-X deployments have matching executable code in retained artifacts
or reconstructed historical source inputs, but the original metadata was not
reproduced. They were **not submitted as approximate source matches**:

| Contract | Address |
| --- | --- |
| L1Owners | `0xa1976bfd72aC7eb03E0AB3dF2382FE26ED836ea4` |
| L1Owners | `0x3D9723aEcBaC6f99a92FC2827f6161388C59A101` |
| L1Owners | `0x565E188A2c0DDbB7C9810b891a0e141f7B78783b` |
| L1Owners | `0x579BBaF443691C2E4c197E9688f05F7F350A8DaB` |
| Historical BidirectionalTreasuryPolicy | `0xb30D777f4E2276156f9b0Da162ac809827e0f1e3` |

The twelve Chiado partial-only entries are ten cross-chain aliases, the EEZ
implementation and the rollup-manager proxy. Their original metadata also remains
to be recovered. The existing allowance module that was initially partial now
has an exact Sourcify runtime match.

Automatic approval review rejected the proposed submission of executable-only
or metadata-only matches because those sources would not reproduce the original
deployed metadata. Continuing with those five EEZ-X addresses requires either
recovery of the matching original build or explicit user approval to publish
clearly identified partial verification. This rejection did not prevent the
exact-source submissions recorded here.

## Executed procedure and failures

1. Enumerated treasury wallet transactions since its first treasury deployment,
   internal creations, receipt log emitters, shared-network deployment records,
   configured protocol contracts and proxy implementations. Explorer requests
   were cached and paced after an initial HTTP 429 response.
2. Matched deployed runtimes against the frozen browser artifacts and retained
   Foundry outputs. Immutable slots were taken from compiler output. Constructor
   arguments were recovered only where creation input had an exact bytecode
   prefix. Every source used to construct an artifact-based input was checked
   against its compiler metadata hash.
3. Reconstructed original Safe/protocol inputs from published verified sources
   and independently compiled them before accepting an exact runtime match.
   Original dashboard bridge artifacts were recovered from the initialized
   runtime checkout without modifying it.
4. Submitted standard JSON input to each explorer. A successful queue submission
   was not considered verification: final address-specific verification flags
   were read independently. The older explorer status API can return HTTP success
   and `status=1` alongside `Fail - Unable to verify`; the result text matters.
5. Three EEZ-X policy submissions failed because its Tesla/Hackney adapter did not
   propagate the verification client's receive timeout correctly. Temporarily
   selected the already installed `Explorer.HttpClient.HTTPoison` adapter while
   retrying source verification, then restored `Explorer.HttpClient.Tesla` in a
   `finally` block. The unchanged original adapter was checked again at the end.
   No service restart, image update, database edit or `.env` change was performed.
6. Chiado's legacy API returned HTTP 429. Its supported v2 upload endpoint
   accepted jobs, but its public `verification_result` WebSocket channel reported
   `response returned with invalid status code; status=500 Internal Server Error`
   for affected contracts. Explicit constructor arguments and Foundry's original
   standard JSON format reproduced that error. A Sourcify import was also
   requested, but did not establish successful explorer import.
7. Used [Sourcify's v2 API](https://docs.sourcify.dev/docs/api/) for exact-source
   Chiado verification. Polled each verification job until completion and retained
   its exact runtime/creation match fields. No deprecated v1 API was used.
8. Rechecked all 103 explorer records and the completed Sourcify results. The
   original dashboard `.env`, frozen deployment artifact bundle and shared
   network profile retain their pre-operation SHA-256 identities. The local UI
   remains healthy; Safes, owners, allowances, balances and setup journals were
   not changed by this operation.

The public compiler errors and request failures were retained, not treated as
passing checks. The local-only detailed attempt records are in
`.runtime/treasury-source-verification-20261022/`.

## Reproducible inputs and identities

[verification-inputs.tar.gz](verification-inputs.tar.gz) contains 18 deduplicated
standard JSON compiler inputs for the exact matched contracts. Each member is
named by its SHA-256; the inventory maps contract addresses to those member
names, the exact compiler version and fully qualified compilation target. The
archive contains public Solidity source, not operator configuration or keys.

- Dashboard: `0d26cf24d2fa23de31021d1a508f137e24804efd`, existing dirty
  `feat/treasury-demo` working tree.
- Runtime checkout: `fa916b13254a36423cad130080dde367bb18a7d6`, read only.
- Pinned core: `855fe0602484750861b4c31502a1a91355d33ed6`.
- Safe: `bf943f80fec5ac647159d26161446ac5d716a294`.
- Safe modules: `c95f03900bff99be090dadb9de1c74b162365485`.
- Compilers: Solidity `0.8.34+commit.80d5c536` and
  `0.7.6+commit.7338295f`, with each input's original settings.

These are live source-verification results, not a new behavioral or security
audit. Contract/runtime test suites were not rerun because no contract or
application implementation changed. Validation consisted of local recompilation,
source hashes, deployed bytecode comparison, explorer/Sourcify results, archive
integrity, preserved-state checks and `git diff --check`.
