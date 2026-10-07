import { decodeErrorResult, decodeFunctionData, decodeFunctionResult, type Abi, type Hex } from "viem";
import { config } from "../config";
import { lookupAddress } from "./addressBook";
import { debugAbi, isDebugManager, type CallTrace, type DebugChain } from "./executionDebugger";

export type ContractAbi = { abi: Abi; name?: string };
const cache = new Map<string, { expires: number; promise: Promise<ContractAbi | null> }>();
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active < 4) active++;
  else await new Promise<void>(resolve => queue.push(resolve));
  try { return await task(); } finally { const next = queue.shift(); if (next) next(); else active--; }
}
async function readJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try { const response = await fetch(url, { signal: controller.signal }); if (!response.ok) throw new Error(`Explorer HTTP ${response.status}`); return await response.json(); }
  finally { clearTimeout(timeout); }
}
export function getExecutionAbi(chain: DebugChain, address: string): Promise<ContractAbi | null> {
  if (isDebugManager(chain, address)) return Promise.resolve({ abi: debugAbi(chain), name: chain === "l1" ? "EEZ registry" : "EEZL2" });
  const base = (chain === "l2" ? config.l2ExplorerApi || config.l2Explorer : config.l1Explorer).replace(/\/$/, "");
  if (!base || !/^0x[\da-f]{40}$/i.test(address)) return Promise.resolve(null);
  const key = `${chain}:${base}:${address.toLowerCase()}`;
  const old = cache.get(key); if (old && old.expires > Date.now()) return old.promise;
  const promise = limited(async () => {
    try {
      const value = await readJson(`${base}/api/v2/smart-contracts/${address}`) as { abi?: Abi; name?: string };
      if (Array.isArray(value.abi)) return { abi: value.abi, name: value.name };
    } catch { /* deployments with only the compatible v1 API */ }
    try {
      const value = await readJson(`${base}/api?module=contract&action=getsourcecode&address=${address}`) as { status?: string; result?: { ABI?: string; ContractName?: string }[] };
      if (value.status === "1" && value.result?.[0]?.ABI) {
        const abi = JSON.parse(value.result[0].ABI) as Abi;
        if (Array.isArray(abi)) return { abi, name: value.result[0].ContractName };
      }
    } catch { /* unverified contracts and unavailable explorers retain raw data */ }
    return null;
  });
  cache.set(key, { promise, expires: Date.now() + 300000 });
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return promise;
}
export function decodeTraceCall(chain: DebugChain, trace: CallTrace, contract: ContractAbi | null) {
  const name = trace.to ? contract?.name || lookupAddress(trace.to) : "Contract creation";
  if (!contract || !trace.input || trace.input.length < 10) return { name, method: undefined, args: undefined, result: undefined, error: undefined };
  try {
    const decoded = decodeFunctionData({ abi: contract.abi, data: trace.input as Hex });
    let result: unknown;
    let error: string | undefined;
    if (trace.output && trace.output !== "0x") {
      try {
        if (trace.error) {
          const decodedError = decodeErrorResult({ abi: contract.abi, data: trace.output as Hex });
          error = `${decodedError.errorName}(${(decodedError.args ?? []).map(String).join(", ")})`;
        } else result = decodeFunctionResult({ abi: contract.abi, functionName: decoded.functionName, data: trace.output as Hex });
      } catch { /* raw output remains available */ }
    }
    return { name: name || (trace.to && isDebugManager(chain, trace.to) ? "EEZ" : undefined), method: decoded.functionName, args: decoded.args, result, error };
  } catch { return { name, method: undefined, args: undefined, result: undefined, error: undefined }; }
}
