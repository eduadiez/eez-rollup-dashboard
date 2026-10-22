# Treasury status RPC routing — 2026-10-21

After submission, the treasury queried `eez_getCrossChainTransaction` on the
regular L2 chain RPC. That endpoint returns JSON-RPC -32601; the configured
Composer endpoint accepts the method. The failed lookup prevented the connected
view and payment history from reaching their existing outcome verification.

The client now uses `l2.front` for Composer status and retains `l2.rpc` for
receipts, blocks and transaction evidence. No outcome criteria, saved request,
manifest, signatures or storage formats changed. Integration diagnostics use the
same endpoint distinction. [Recovery guidance](../../runbooks/treasury-shared-network.md#recovery-and-configuration)
keeps the existing submission and resumes verification after a UI reload.

Validation:

- The new HTTP regression reproduced `Method not found` before the fix. Separate
  chain and Composer routes now pass settled, speculative, unknown and explicit
  terminal-rejection cases. A missing Composer method still fails verification;
  the saved intent remains unchanged and no send/sign RPC is called.
- The actual client against the configured live endpoints reproduced the error
  before the fix and returned unresolved/pending afterward for the same unknown
  zero hash. This read-only probe does not establish the user’s payment outcome.
- `npm test`: 319 passed, none failed or skipped. Production TypeScript/Vite and
  Docker builds passed; the existing chunk-size warning remains.
- `node --check` passed for all four adjusted integration diagnostic scripts.
  Native Composer/proof/follower integration was not rerun for this routing fix.
- `git diff --check` passed. No browser wallet, live transaction, contract or
  runtime service was changed.

Only the local UI was recreated as `eez-rollup-ui:treasury-status-rpc-20261021`.
Served HTML, entry assets and the treasury bundle matched the build. Runtime
configuration and monitor/node/signer identities remained unchanged.
[Evidence and source hashes](evidence.json) identify the existing dirty checkout;
logs and the baseline source snapshots are local-only in
`.runtime/treasury-status-rpc-20261021/`.
