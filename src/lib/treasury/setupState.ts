import { keccak256, toHex } from "viem";
import { parseTreasuryConfig } from "./client.ts";
import type { TreasuryConfig } from "./client.ts";
import { legacyDeploymentKey, legacyManifestKey, loadDeployment, sharedDeploymentKey, sharedManifestKey } from "./deployment.ts";
import type { DeploymentState } from "./deployment.ts";

type Reader = Pick<Storage, "getItem">;
export const policyUpgradeKey = (instance: string) => `${sharedDeploymentKey}:policy-upgrade:${instance}`;
export function policyUpgradePending(storage: Reader, manifest: TreasuryConfig): boolean {
  const raw = storage.getItem(policyUpgradeKey(manifest.instance));
  if (raw === null) return false;
  // Only a published, verified replacement manifest ends the handover. Invalid
  // or partially written records keep actions blocked rather than enable retry.
  try {
    const record = JSON.parse(raw);
    return !(manifest.payments?.predecessor && manifest.payments.policy.toLowerCase() === record.state?.addresses?.policy?.toLowerCase()
      && manifest.payments.predecessor.toLowerCase() === record.previous?.payments?.policy?.toLowerCase());
  } catch { return true; }
}
export const setupStorageKeys = [sharedDeploymentKey, legacyDeploymentKey, sharedManifestKey, legacyManifestKey];
export type SetupSnapshot = { state: DeploymentState | null; manifest: TreasuryConfig | null; blocked: string };
export type TreasuryActionGuard = (action: () => Promise<void>) => Promise<void>;
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

/** An empty journal explicitly selects the setup chooser and masks legacy
 * fallback. A retained manifest is active only for the selected journal
 * salt and Safe addresses; restarting must not reopen an old treasury. */
export function loadActiveManifest(storage: Reader): TreasuryConfig | null {
  if (storage.getItem(sharedDeploymentKey) === "") return null;
  const state = loadDeployment(storage);
  if (state && (!state.addresses.safeL1 || !state.addresses.safeL2)) return null;
  const raw = storage.getItem(sharedManifestKey) ?? storage.getItem(legacyManifestKey);
  if (!raw) return null;
  const manifest = parseTreasuryConfig(JSON.parse(raw));
  if (state && manifest.instance !== keccak256(toHex(`${state.salt}:${state.addresses.safeL1}:${state.addresses.safeL2}`))) return null;
  return manifest;
}

export function setupSnapshot(storage: Reader): SetupSnapshot {
  const state = loadDeployment(storage), manifest = loadActiveManifest(storage);
  const blocked = manifest && policyUpgradePending(storage, manifest) ? "Finish the policy upgrade before starting a new treasury." : state?.pending ? "Resolve the pending setup transaction before starting a new treasury."
    : manifest && storage.getItem(`eez:treasury:submission:${manifest.instance}`) !== null
      ? "A payment or action is pending verification."
      : manifest && storage.getItem(`eez:treasury:owners:${manifest.instance}`) !== null
        ? "Finish the owner change and choose Done before starting a new treasury." : "";
  return { state, manifest, blocked };
}

/** Caller holds sharedDeploymentKey's Web Lock. One write returns to the
 * chooser; a failed write leaves the current setup active. Retained manifests,
 * history and legacy records are not deleted or selected by this operation. */
export function restartSetup(storage: Pick<Storage, "getItem" | "setItem">, expected: SetupSnapshot): void {
  const current = setupSnapshot(storage);
  // Progress can refresh while the button is visible. Bind the action to the
  // selected treasury, then check its current pending requests inside the lock.
  check(current.state?.salt === expected.state?.salt && current.manifest?.instance === expected.manifest?.instance, "Treasury changed in another tab. Review the current setup before restarting");
  check(current.state || current.manifest, "There is no saved treasury to restart");
  check(!current.blocked, current.blocked);
  storage.setItem(sharedDeploymentKey, "");
}

/** Live actions share the restart/setup lock. Checking selection inside that
 * lock prevents an already-open tab from signing or sending for a previous treasury. */
export async function withActiveTreasury(storage: Reader, locks: Pick<LockManager, "request">, instance: string, action: () => Promise<void>, expectedPolicy?: string) {
  if (!locks) throw new Error("Treasury actions require browser Web Locks support");
  await locks.request(sharedDeploymentKey, { ifAvailable: true }, async lock => {
    check(lock, "Another treasury action is running. Wait for it to finish");
    const current = loadActiveManifest(storage);
    check(current?.instance === instance, "This treasury is no longer active. Reload before continuing");
    check(!expectedPolicy || current?.payments?.policy.toLowerCase() === expectedPolicy.toLowerCase(), "The payment policy changed. Reload before continuing");
    check(!current || !policyUpgradePending(storage, current), "Finish the policy upgrade before making another treasury action");
    await action();
  });
}
