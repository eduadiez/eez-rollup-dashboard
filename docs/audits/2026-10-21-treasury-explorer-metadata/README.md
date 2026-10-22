# Chiado Test USDC explorer metadata — 2026-10-21

Status: source verification completed; ERC-20 metadata refresh remains external.
The existing token, bridge pair, treasury bindings and six-decimal precision were
preserved. No wallet transaction was signed or broadcast.

## Reproduced behavior and operation

The deployed token is `0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb` on Chiado
(chain 10200). Both the dashboard RPC and independent public Chiado RPC returned
`Test USD Coin`, `Test USDC`, six decimals and raw supply `900000000` (900 tokens).
At the same time Blockscout returned null name, symbol, decimals and supply,
and initially did not recognize this address as a contract. The EEZ-X wrapped
token already had the correct metadata.

Matched all 30 source hashes and compiler settings against the token artifact,
and matched the on-chain runtime to that artifact outside its immutable slots.
Prepared the Solidity standard JSON input with:

```bash
forge verify-contract --root contracts --show-standard-json-input --chain 10200 \
  0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb \
  src/SharedTestUSDC.sol:SharedTestUSDC
```

Submitted that input to the public Chiado Blockscout `/api` verification endpoint
using `module=contract`, `action=verifysourcecode`,
`codeformat=solidity-standard-json-input`, compiler
`v0.8.34+commit.80d5c536`, and the exact contract name. No private source, credentials
or authenticated endpoint was submitted. The accepted verification identifier is
`67732ead04cf5c6665cb95b87e48ec2b712541eb6ad92add`.
The status endpoint subsequently returned **Pass - Verified**. The contract API
reports a full match (`is_verified=true`, `is_partially_verified=false`).

## Remaining limitation

The token API still returns null ERC-20 metadata after verification. Source
verification repaired the contract-code record but did not refresh the token
catalog. Do not describe verification as fixing the displayed token amounts.

Blockscout v12.0.1 exposes metadata-refresh endpoints for NFT instances; those
explicitly reject ERC-20 tokens. Token-info import is an administrator operation,
not an unauthenticated public metadata refresh. The remaining repair needs the
Chiado explorer's token indexer to reread the existing contract's metadata. No
administrator credentials are available in this task, and no support message was
sent. A token redeployment or decimal change would not repair this index record.

Public checks:

- [Token metadata](https://gnosis-chiado.blockscout.com/api/v2/tokens/0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb).
- [Verified contract](https://gnosis-chiado.blockscout.com/address/0x67732Ead04CF5c6665Cb95b87e48Ec2B712541Eb?tab=contract).
- [Blockscout v12.0.1 token routes](https://github.com/blockscout/blockscout/blob/v12.0.1/apps/block_scout_web/lib/block_scout_web/routers/tokens_api_v2_router.ex).
- [Refresh eligibility](https://github.com/blockscout/blockscout/blob/v12.0.1/apps/block_scout_web/lib/block_scout_web/controllers/api/v2/token_controller.ex).
- [Administrator import](https://github.com/blockscout/blockscout/blob/v12.0.1/apps/block_scout_web/lib/block_scout_web/controllers/api/v2/import_controller.ex).

The compact [evidence](evidence.json) records the before/after public responses,
source/compiler identity and independent on-chain observations. The full standard
input and responses remain local-only under
`.runtime/treasury-explorer-metadata-fix-20261021/`. This is live read-only chain
evidence plus a public source-verification submission, not a token modification.
Solidity runtime tests were not rerun: no contracts or protocol code changed.
