import { readIntent } from "./client.ts";
import type { Intent, Outcome, TreasuryConfig } from "./client.ts";
import { checkedPayment } from "./payments.ts";
import type { Payment } from "./payments.ts";

/** Resolve old receipts against their original policy, never the replacement. */
export function historyConfig(config: TreasuryConfig, intent: Intent): TreasuryConfig {
  try { readIntent(config, JSON.stringify(intent)); return config; }
  catch (error) {
    if (!config.previousPayments) throw error;
    const previous = { ...config, payments: config.previousPayments, previousPayments: config.olderPayments?.[0],
      olderPayments: (config.olderPayments?.length ?? 0) > 1 ? config.olderPayments!.slice(1) : undefined };
    return historyConfig(previous, intent);
  }
}
export type HistoryEntry = { id: string; recordedAt: string } & (
  { kind: "submitted"; intent: Intent } |
  { kind: "preparation"; payment: Payment; detail: string }
);
export type HistoryObservation = { outcome?: Outcome; checkedAt?: string; error?: string; checking?: boolean };
export type HistoryStatus = "settled" | "preparation" | "rollback" | "pending" | "rejected";
export const historyKey = (c: TreasuryConfig) => `eez:treasury:history:${c.instance}`;
// The Safe hash alone collapses retries that reuse its unconsumed nonce. Keep
// source identity and the starting block; recovering a response hash updates it.
export const attemptId = (i: Intent) => `${i.safeHash}:${i.sender.toLowerCase()}:${BigInt(i.sourceNonce)}:${BigInt(i.startBlock)}`;
export function historyStatus(entry: HistoryEntry, observation?: HistoryObservation): HistoryStatus {
  if (entry.kind === "preparation") return "preparation";
  if (observation?.error || observation?.checking) return "pending";
  const o = observation?.outcome;
  if (o?.kind === "settled") return "settled";
  if (o?.kind === "rejected") return o.rollback ? "rollback" : o.rejectionStage === "preparation" ? "preparation" : "rejected";
  return "pending";
}
export const historyLabels: Record<HistoryStatus, string> = {
  settled: "Settled", preparation: "Preparation rejected", rollback: "Rollback verified", pending: "Unresolved", rejected: "Request rejected",
};

/** Only identities and local review failures are persisted. Outcomes must be
 * obtained again from the connected devnet; browser data cannot prove settlement. */
export class PaymentHistoryStore {
  readonly config: TreasuryConfig;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  constructor(config: TreasuryConfig, storage: Pick<Storage, "getItem" | "setItem">) { this.config = config; this.storage = storage; }
  read(): HistoryEntry[] {
    const text = this.storage.getItem(historyKey(this.config));
    if (text === null) return [];
    const saved = JSON.parse(text);
    if (saved?.version !== 1 || saved.instance !== this.config.instance || !Array.isArray(saved.entries)) throw new Error("Invalid payment history for this devnet");
    const ids = new Set<string>();
    return saved.entries.map((entry: HistoryEntry) => {
      if (!entry || typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.recordedAt !== "string"
          || !Number.isFinite(Date.parse(entry.recordedAt))) throw new Error("Invalid payment history entry");
      ids.add(entry.id);
      if (entry.kind === "submitted") {
        const intent = readIntent(historyConfig(this.config, entry.intent), JSON.stringify(entry.intent));
        if (!intent?.payment || attemptId(intent) !== entry.id) throw new Error("Payment history identity mismatch");
        return { id: entry.id, recordedAt: entry.recordedAt, kind: entry.kind, intent };
      }
      if (entry.kind !== "preparation" || !/^[a-f0-9-]{36}$/i.test(entry.id) || typeof entry.detail !== "string" || entry.detail.length > 2000)
        throw new Error("Invalid preparation history entry");
      return { id: entry.id, recordedAt: entry.recordedAt, kind: entry.kind, payment: checkedPayment(entry.payment), detail: entry.detail };
    });
  }
  private write(entries: HistoryEntry[]) {
    this.storage.setItem(historyKey(this.config), JSON.stringify({ version: 1, instance: this.config.instance, entries }));
    return entries;
  }
  remember(intent: Intent): HistoryEntry[] {
    const entries = this.read();
    if (!intent.payment) return entries;
    readIntent(historyConfig(this.config, intent), JSON.stringify(intent));
    const id = attemptId(intent), index = entries.findIndex(e => e.id === id);
    const old = entries[index];
    if (old?.kind === "submitted" && old.intent.hash && intent.hash && old.intent.hash !== intent.hash)
      throw new Error("Conflicting transaction hashes for a saved payment attempt");
    const next: HistoryEntry = { id, kind: "submitted", recordedAt: old?.recordedAt ?? new Date().toISOString(),
      intent: { ...intent, ...(old?.kind === "submitted" && old.intent.hash ? { hash: old.intent.hash } : {}) } };
    if (old && JSON.stringify(old) === JSON.stringify(next)) return entries;
    if (index < 0) entries.push(next); else entries[index] = next;
    return this.write(entries);
  }
  reject(payment: Payment, detail: string): HistoryEntry[] {
    const entries = this.read();
    entries.push({ kind: "preparation", id: crypto.randomUUID(), recordedAt: new Date().toISOString(), payment: checkedPayment(payment), detail: detail.slice(0, 2000) });
    return this.write(entries);
  }
  cancel(intent: Intent): HistoryEntry[] {
    const entries = this.read(), id = attemptId(intent);
    const entry = entries.find(e => e.id === id);
    if (intent.hash || (entry?.kind === "submitted" && entry.intent.hash)) throw new Error("Cannot remove a submitted payment");
    return this.write(entries.filter(e => e.id !== id));
  }
}
