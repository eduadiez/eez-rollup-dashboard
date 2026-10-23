# Isolated wallet/Safe rehearsal preparation — 2026-10-20

This work was superseded by the user's request to use the normal dashboard's
Chiado/EEZ-X networks. The [shared-network record](../2026-10-20-treasury-shared-network/README.md)
tracks that continuation. The isolated services and evidence were preserved.

The pinned Safe stack indexed the real isolated L1 Safe and matched on-chain
owners, threshold and nonce. Canonical auxiliary contracts were deployed with
verified bytecode on the owned private L1. The last backend readiness check
passed at 16:30 UTC. The subsequent read-only browser smoke failed while waiting
for **Manage signers**; official Safe frontend administration and real wallet
extension signing were **not completed**. No human rehearsal is claimed.

Local-only evidence is under
`.runtime/treasury-integration/20261020T151413-q72r2wk7/safe-app/`, including
`readiness.json`, `browser-readiness.json`, source/image metadata and screenshots.
These ignored files are not available to a fresh checkout. The normal dashboard
configuration was unchanged during this private-stack work.

Before the shared-network changes, 236 JavaScript tests, five Safe-stack Python
checks and the TypeScript/Vite build passed. Those results do not validate the
later shared-network work or the failed Safe-app browser path. The original
presenter runbook remains an isolated procedure with a pending human rehearsal.
