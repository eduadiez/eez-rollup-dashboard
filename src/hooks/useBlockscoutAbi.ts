import { useEffect, useState } from "react";
import { config } from "../config";
import { registerAddress } from "../lib/addressBook";

export interface AbiFunction {
  name: string;
  inputs: { name: string; type: string }[];
  outputs?: { name: string; type: string }[];
  stateMutability: string;
}
interface AbiResult { abi: AbiFunction[] | null; contractName: string | null; loading: boolean; error: string | null; }
const empty: AbiResult = { abi: null, contractName: null, loading: false, error: null };
const cache = new Map<string, AbiResult>();

export function useBlockscoutAbi(address: string, chain: "l1" | "l2" = "l2"): AbiResult {
  const base = chain === "l1" ? config.l1ExplorerApi : config.l2ExplorerApi;
  const addr = address.trim().toLowerCase();
  const key = `${base}:${chain}:${addr}`;
  const [result, setResult] = useState<{ key: string; value: AbiResult }>({ key: "", value: empty });
  useEffect(() => {
    if (!base || !/^0x[0-9a-f]{40}$/.test(addr)) { setResult({ key, value: empty }); return; }
    const cached = cache.get(key);
    if (cached) { setResult({ key, value: cached }); return; }
    const controller = new AbortController();
    setResult({ key, value: { ...empty, loading: true } });
    const timer = setTimeout(async () => {
      try {
        const request = async (action: string) => {
          const response = await fetch(`${base.replace(/\/$/, "")}/api?module=contract&action=${action}&address=${addr}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`Explorer returned ${response.status}`);
          return response.json();
        };
        const [abiResult, nameResult] = await Promise.allSettled([request("getabi"), request("getsourcecode")]);
        if (controller.signal.aborted) return;
        if (abiResult.status === "rejected") throw abiResult.reason;
        const abiJson = abiResult.value;
        const rawAbi = abiJson.status === "1" && abiJson.result ? (typeof abiJson.result === "string" ? JSON.parse(abiJson.result) : abiJson.result) : [];
        const functions: AbiFunction[] = Array.isArray(rawAbi) ? rawAbi.filter(item => item.type === "function").map(item => ({
          name: item.name, inputs: item.inputs || [], outputs: item.outputs || [], stateMutability: item.stateMutability || "nonpayable",
        })) : [];
        const contractName = nameResult.status === "fulfilled" && nameResult.value.status === "1" ? nameResult.value.result?.[0]?.ContractName || null : null;
        if (contractName) registerAddress(addr, contractName, chain);
        const value = { abi: functions.length ? functions : null, contractName, loading: false, error: null };
        cache.set(key, value); setResult({ key, value });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, value: { ...empty, error: error instanceof Error ? error.message : "Unable to fetch ABI" } });
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [addr, base, chain, key]);
  // Never expose ABI from the previously selected address or chain, even for the first render.
  return result.key === key ? result.value : empty;
}
