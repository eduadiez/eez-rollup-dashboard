import type { TraceJob, TraceRequest, TraceResult } from "../../trace-decoder/service/types";

const base = import.meta.env.BASE_URL + "trace/api";
async function request<T>(path: string, options: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(base + path, { ...options, credentials: "same-origin" }); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("The trace service could not be reached. Please retry.");
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The trace service is unavailable on this deployment.");
  }
  const body = await response.json() as T & { error?: string; apiVersion?: number };
  if (!body || typeof body !== "object") throw new Error("The trace service returned an invalid response.");
  if (!response.ok) throw new Error(body.error || "The trace request failed.");
  if (body.apiVersion !== 1) throw new Error("The trace service returned an unsupported response.");
  return body;
}
export const startTrace = (body: TraceRequest, signal: AbortSignal) =>
  request<TraceJob>("/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
export const readTraceJob = (id: string, signal: AbortSignal) =>
  request<TraceJob>("/jobs/" + encodeURIComponent(id), { signal });
export const readTraceResult = (id: string, signal: AbortSignal) =>
  request<TraceResult>("/jobs/" + encodeURIComponent(id) + "/result", { signal });
export function releaseTrace(id: string): void {
  void fetch(base + "/jobs/" + encodeURIComponent(id), {
    method: "DELETE", credentials: "same-origin", keepalive: true,
  }).catch(() => { /* The server also expires abandoned viewer leases. */ });
}
