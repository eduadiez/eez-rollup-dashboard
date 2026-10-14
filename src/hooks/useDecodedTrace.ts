import { useCallback, useEffect, useRef, useState } from "react";
import { L1_CHAIN, L2_CHAIN } from "../config";
import { readTraceJob, readTraceResult, releaseTrace, startTrace } from "../lib/traceApi";
import type { TraceResult, TraceSource } from "../../trace-decoder/service/types";

interface State {
  phase: "idle" | "queued" | "running" | "complete" | "failed" | "cancelled";
  progress: string;
  result: TraceResult | null;
  error: string | null;
}
const initial: State = { phase: "idle", progress: "", result: null, error: null };
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { window.clearTimeout(timer); reject(signal.reason); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function useDecodedTrace(hash: string, chain: TraceSource, ready: boolean) {
  const [state, setState] = useState<State>(initial);
  const [revision, setRevision] = useState(0);
  const current = useRef<{ controller: AbortController; id?: string } | null>(null);
  useEffect(() => {
    setState(initial);
    if (!ready || !hash) return;
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) {
      setState({ ...initial, phase: "failed", error: "Enter a complete transaction hash." });
      return;
    }
    const run: { controller: AbortController; id?: string } = { controller: new AbortController() };
    current.current = run;
    const { signal } = run.controller;
    setState({ ...initial, phase: "queued", progress: "Requesting transaction details" });
    void (async () => {
      try {
        let job = await startTrace({
          hash, chain, refresh: revision > 0,
          chainIds: { l1: BigInt(L1_CHAIN.chainId).toString(), l2: BigInt(L2_CHAIN.chainId).toString() },
        }, signal);
        run.id = job.id;
        if (signal.aborted) return;
        while (job.state === "queued" || job.state === "running") {
          if (signal.aborted) return;
          setState({ ...initial, phase: job.state, progress: job.progress });
          await pause(signal);
          job = await readTraceJob(job.id, signal);
        }
        if (signal.aborted) return;
        if (job.state === "failed") throw new Error(job.error || "Trace decoding failed.");
        const result = await readTraceResult(job.id, signal);
        if (!signal.aborted) setState({ phase: "complete", progress: job.progress, result, error: null });
      } catch (error) {
        if (!signal.aborted) setState({ ...initial, phase: "failed", error: error instanceof Error ? error.message : "Trace decoding failed." });
      } finally {
        if (run.id) releaseTrace(run.id);
        if (current.current === run) current.current = null;
      }
    })();
    return () => {
      run.controller.abort();
      if (run.id) releaseTrace(run.id);
      if (current.current === run) current.current = null;
    };
  }, [hash, chain, ready, revision]);
  const cancel = useCallback(() => {
    const run = current.current;
    if (!run) return;
    run.controller.abort();
    if (run.id) releaseTrace(run.id);
    setState({ ...initial, phase: "cancelled", progress: "Trace request cancelled" });
  }, []);
  return { ...state, cancel, refresh: () => setRevision(value => value + 1) };
}
