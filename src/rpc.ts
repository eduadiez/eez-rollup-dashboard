/** Low-level JSON-RPC client */

let _id = 1;

/** Preserve structured RPC error evidence for callers that need to classify it. */
export class RpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(error: { message: string; code?: number; data?: unknown }) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export async function rpcCall(
  url: string,
  method: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: _id++ }),
    signal,
  });
  const data = (await res.json()) as {
    result?: unknown;
    error?: { message: string; code?: number; data?: unknown };
  };
  if (data.error) throw new RpcError(data.error);
  return data.result;
}
