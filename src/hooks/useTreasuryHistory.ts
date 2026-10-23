import { useCallback, useEffect, useRef, useState } from "react";
import { TreasuryClient } from "../lib/treasury/client";
import type { Intent, Outcome } from "../lib/treasury/client";
import type { Payment } from "../lib/treasury/payments";
import { attemptId, historyConfig, historyKey, PaymentHistoryStore } from "../lib/treasury/history";
import type { HistoryEntry, HistoryObservation } from "../lib/treasury/history";
import { settlementIdentity, treasurySettlement } from "../lib/treasury/settlement";
import type { TreasurySettlement } from "../lib/treasury/settlement";

export function useTreasuryHistory(client: TreasuryClient, restored: Intent | null, enabled: boolean) {
  const [store] = useState(() => new PaymentHistoryStore(client.config, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }));
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [observations, setObservations] = useState<Record<string, HistoryObservation>>({});
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const update = useCallback((action: () => HistoryEntry[]) => {
    try { const next = action(); setEntries(next); setError(""); return next; }
    catch (failure) { const message = `Payment history could not be saved or read: ${failure instanceof Error ? failure.message : String(failure)}. Existing records have been kept.`;
      setError(message); throw new Error(message); }
  }, []);
  const remember = useCallback((intent: Intent) => update(() => store.remember(intent)), [store, update]);
  const reject = useCallback((payment: Payment, detail: string) => update(() => store.reject(payment, detail)), [store, update]);
  const cancel = useCallback((intent: Intent) => update(() => store.cancel(intent)), [store, update]);
  const observe = useCallback((intent: Intent, outcome: Outcome) => {
    if (intent.payment) setObservations(previous => ({ ...previous, [attemptId(intent)]: { outcome, checkedAt: new Date().toISOString() } }));
  }, []);
  // One sequential reconciliation per refresh; no RPC fan-out proportional to
  // the journal size. This never changes the active request or sends a payment.
  const refresh = useCallback(async () => {
    if (running.current) return;
    running.current = true; setChecking(true);
    const current = generation.current;
    try {
      const saved = restored?.payment ? update(() => store.remember(restored)) : update(() => store.read());
      await client.validate();
      for (const entry of [...saved].reverse()) {
        if (current !== generation.current) return;
        if (entry.kind !== "submitted") continue;
        setObservations(previous => ({ ...previous, [entry.id]: { checking: true } }));
        try {
          const config = historyConfig(client.config, entry.intent);
          const outcome = await (config === client.config ? client : new TreasuryClient(config)).outcome(entry.intent);
          if (current !== generation.current) return;
          if (outcome.hash && outcome.hash !== entry.intent.hash) remember({ ...entry.intent, hash: outcome.hash });
          observe(entry.intent, outcome);
        } catch (failure) {
          if (current !== generation.current) return;
          setObservations(previous => ({ ...previous, [entry.id]: { error: failure instanceof Error ? failure.message : String(failure) } }));
        }
      }
    } catch (failure) {
      if (current === generation.current) { setError(failure instanceof Error ? failure.message : String(failure)); setObservations({}); }
    } finally { if (current === generation.current) { running.current = false; setChecking(false); } }
  }, [client, store, restored, update, remember, observe]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const changed = (event: StorageEvent) => { if (event.key === historyKey(client.config) || event.key === null) void refresh(); };
    window.addEventListener("storage", changed);
    return () => { generation.current++; running.current = false; window.removeEventListener("storage", changed); };
  }, [client, enabled, refresh]);
  // Share optional explorer evidence between collapsed rows and the active flow.
  // Reconcile sequentially even for a long journal; opening details adds no RPCs.
  const queries = Object.values(observations).flatMap(({ outcome, checking, error }) =>
    !checking && !error && settlementIdentity(outcome) ? [{ kind: "settled" as const, detail: "", block: outcome!.block, execution: { l2: outcome!.execution!.l2 } }] : []);
  const queryKey = JSON.stringify(queries);
  const [evidence, setEvidence] = useState<{ key: string; records: Record<string, TreasurySettlement | null> }>({ key: "", records: {} });
  const requestedEvidence = useRef({ key: queryKey, queries });
  requestedEvidence.current = { key: queryKey, queries };
  const refreshEvidence = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true, running = false, timer: ReturnType<typeof setTimeout>;
    const reconcile = async () => {
      if (!alive || running) return;
      clearTimeout(timer); running = true;
      const request = requestedEvidence.current;
      for (const outcome of request.queries) {
        if (!alive || requestedEvidence.current.key !== request.key) break;
        let settlement: TreasurySettlement | null = null;
        try { settlement = await treasurySettlement(client, outcome); } catch { /* Optional links never change payment verification. */ }
        if (!alive || requestedEvidence.current.key !== request.key) break;
        setEvidence(previous => ({ key: request.key, records: { ...(previous.key === request.key ? previous.records : {}), [settlementIdentity(outcome)!]: settlement } }));
      }
      running = false;
      if (alive) timer = setTimeout(reconcile, requestedEvidence.current.key === request.key ? 10000 : 0);
    };
    refreshEvidence.current = () => { void reconcile(); };
    void reconcile();
    return () => { alive = false; refreshEvidence.current = null; clearTimeout(timer); };
  }, [client, enabled]);
  useEffect(() => { refreshEvidence.current?.(); }, [queryKey]);
  const settlementFor = (outcome?: Outcome | null) => {
    const identity = settlementIdentity(outcome);
    return identity && evidence.key === queryKey ? evidence.records[identity] : undefined;
  };
  return { entries, observations, error, checking, remember, reject, cancel, observe, refresh, settlementFor };
}
