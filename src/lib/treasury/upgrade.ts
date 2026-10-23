import { paymentVersion } from "./savedPayments.ts";
import { zeroAddress } from "viem";
import { parseTreasuryConfig } from "./client.ts";
import type { TreasuryConfig } from "./client.ts";
import { readDeployment } from "./deployment.ts";
import type { Chain, DeploymentState } from "./deployment.ts";
import type { SetupTransaction } from "./setupTransactions.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export type PolicyUpgrade = { version: 1 | 2; previous: TreasuryConfig; helpers: Chain[]; state: DeploymentState; previousUpgrade?: PolicyUpgrade };
export function readUpgrade(raw: string | null, current: TreasuryConfig): PolicyUpgrade | null {
  if (!raw) return null;
  const record = JSON.parse(raw) as PolicyUpgrade;
  check((record.version === 1 || record.version === 2) && Array.isArray(record.helpers) && record.helpers.every(c => c === "l1" || c === "l2")
    && new Set(record.helpers).size === record.helpers.length, "Invalid policy upgrade record; keep it for recovery");
  const previous = parseTreasuryConfig(record.previous);
  check(previous.instance === current.instance && previous.payments && (record.version === 1 ? paymentVersion(previous.payments) === 0 && !previous.previousPayments : paymentVersion(previous.payments) === 0)
    && same(previous.safeL1, current.safeL1) && same(previous.safeL2, current.safeL2), "Upgrade belongs to another treasury");
  check(record.state && readDeployment(JSON.stringify(record.state)) && record.state.version === 2 && !record.state.bidirectional
    && same(record.state.addresses.safeL1!, current.safeL1) && same(record.state.addresses.safeL2!, current.safeL2)
    && same(record.state.addresses.adapter!, current.adapter), "Upgrade Safe bindings changed");
  check(same(current.payments!.policy, previous.payments.policy)
    || same(current.payments!.policy, record.state.addresses.policy ?? zeroAddress) && same(current.previousPayments?.policy ?? zeroAddress, previous.payments.policy), "Active policy changed during upgrade");
  for (const key of ["moduleL1", "moduleL2", "tokenL1", "tokenL2", "bridgeL1", "bridgeL2", "aliasReaderL1"] as const)
    check(same(record.state.addresses[key] ?? zeroAddress, previous.payments[key] ?? zeroAddress), "Upgrade replaced an existing treasury contract");
  if (record.previousUpgrade) {
    check(record.version === 2 && record.previousUpgrade.version === 1 && !record.previousUpgrade.previousUpgrade,
      "Invalid retained upgrade history");
    readUpgrade(JSON.stringify(record.previousUpgrade), previous);
    check(same(record.previousUpgrade.state.addresses.policy ?? zeroAddress, previous.payments.policy), "Previous handover is unfinished");
  }
  return record;
}

/** Display retained handover receipts without constructing executable calls. */
export function upgradeTransactions(record: PolicyUpgrade): SetupTransaction[] {
  const { state } = record;
  const plan = [
    ...record.helpers.map(chain => ({ id: chain === "l1" ? "multiSendL1" : "multiSendL2", chain,
      label: `Prepare Safe batching on ${chain === "l1" ? "Chiado" : "EEZ-X"}` })),
    { id: "upgradePolicy", chain: "l2" as const, label: "Deploy the replacement payment policy" },
    { id: "upgradeL1", chain: "l1" as const, label: "Approve the Chiado handover" },
    { id: "upgradeL2", chain: "l2" as const, label: "Approve the EEZ-X handover" },
  ];
  check(state.completed.length <= plan.length && state.completed.every((id, index) => plan[index]?.id === id),
    "Saved policy upgrade order changed");
  const rows: SetupTransaction[] = state.completed.map((_, index) => ({ ...plan[index]!,
    hash: state.transactions[index]!, completed: true, inclusion: state.inclusions?.[state.transactions[index]!] }));
  if (state.pending) {
    const step = plan[state.completed.length];
    check(step && step.id === state.pending.id && step.chain === state.pending.chain, "Saved policy upgrade transaction changed");
    rows.push({ ...step, hash: state.pending.hash, completed: false });
  }
  return rows;
}
