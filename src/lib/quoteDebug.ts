import { decodeAbiParameters, toFunctionSelector, type Abi, type AbiFunction, type AbiParameter, type Hex } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;

export type QuoteFields = { from: string; to: string; data: string; value: string; gas: string; nonce: string };
export type CapturedBytes = { hex: Hex; length: number; truncated: boolean };
export type QuoteFrame = {
  id: number; chainId: string; codeAddress: string | null; to: string | null;
  kind: string; status: string; input: CapturedBytes; output?: CapturedBytes;
};
export type QuoteRun = { id: number; frames: QuoteFrame[] };
export type QuoteContext = { l1ChainId: string; l2ChainId: string };
export type DecodedQuoteFrame = {
  id: number; name?: string; method?: string; signature?: string;
  arguments?: string; returns?: string; error?: string; note: string;
};
export type VerifiedAbi = { abi: Abi; name?: string };
export const MAX_QUOTE_BYTES = 8 * 1024 * 1024;
const MAX_ABI_BYTES = 1024 * 1024;
const addressPattern = /^0x[0-9a-f]{40}$/i;

function quantity(value: string, label: string, bits = 256): Hex {
  const text = value.trim();
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text) || text.length > 80) throw new Error(`${label} must be an unsigned integer (decimal or hex).`);
  const number = BigInt(text);
  if (number >= 1n << BigInt(bits)) throw new Error(`${label} exceeds ${bits} bits.`);
  return `0x${number.toString(16)}`;
}

export function buildDebugQuote(fields: QuoteFields, type: "0x0" | "0x2" | "both") {
  const from = fields.from.trim(), to = fields.to.trim(), data = fields.data.trim() || "0x";
  if (!addressPattern.test(from)) throw new Error("Enter a 20-byte sender address.");
  if (to && !addressPattern.test(to)) throw new Error("Enter a 20-byte target address, or leave it empty for contract creation.");
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error("Calldata must be 0x followed by complete hex bytes.");
  if (data.length > 2 + 128 * 1024 * 2) throw new Error("Calldata exceeds the debugger's 128 KiB limit.");
  const transaction: Record<string, string> = { from, data, value: quantity(fields.value || "0", "Value") };
  if (to) transaction.to = to;
  if (fields.gas.trim()) {
    transaction.gas = quantity(fields.gas, "Gas limit", 64);
    if (transaction.gas === "0x0") throw new Error("Gas limit must be positive, or empty for automatic estimation.");
  }
  if (fields.nonce.trim()) transaction.nonce = quantity(fields.nonce, "Nonce", 64);
  return { jsonrpc: "2.0", id: "dashboard-quote", method: "eez_debugQuoteFee", params: [transaction,
    { trace: "calls", ...(type === "both" ? {} : { transactionTypes: [type] }) }] };
}

async function boundedText(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response body.");
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error(`Response exceeds ${limit / 1024} KiB.`); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function requestDebugQuote(url: string, request: ReturnType<typeof buildDebugQuote>, signal: AbortSignal) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  const text = await boundedText(response, MAX_QUOTE_BYTES);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Composer returned an invalid JSON response (HTTP ${response.status}).`); }
  if (!response.ok && !body?.error) throw new Error(`Composer HTTP ${response.status}.`);
  if (body?.id !== request.id || body?.jsonrpc !== "2.0") throw new Error("Composer returned an unrelated JSON-RPC response.");
  // Preserve error.data.trace: operational failures can still include useful calls.
  return text;
}

export function quoteChain(chainId: string, configured: { l1: string | null; l2: string | null }): "l1" | "l2" | null {
  try {
    const matches = (["l1", "l2"] as const).filter(chain => {
      const id = configured[chain];
      return typeof id === "string" && /^0x[0-9a-f]+$/i.test(id) && BigInt(chainId) === BigInt(id);
    });
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}

function validParameters(parameters: unknown, depth = 0): parameters is readonly AbiParameter[] {
  if (!Array.isArray(parameters) || parameters.length > 128 || depth > 12) return false;
  return parameters.every(parameter => {
    if (!parameter || typeof parameter.type !== "string" || parameter.type.length > 96 ||
      (parameter.name !== undefined && (typeof parameter.name !== "string" || parameter.name.length > 256))) return false;
    const arrays = [...parameter.type.matchAll(/\[([0-9]*)\]/g)];
    if (arrays.length > 8 || arrays.some(match => match[1] && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || Number(match[1]) > 4096))) return false;
    const type = parameter.type.replace(/\[[0-9]*\]/g, "");
    if (type === "tuple") return parameter.components?.length > 0 && validParameters(parameter.components, depth + 1);
    return /^(?:address|bool|string|bytes(?:[1-9]|[12][0-9]|3[0-2])?|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?)$/.test(type);
  });
}

function safeAbi(value: unknown): Abi | null {
  if (!Array.isArray(value) || value.length > 1024) return null;
  const items = value.filter(item => item?.type === "function" || item?.type === "error");
  if (items.some(item => typeof item.name !== "string" || item.name.length > 256 ||
    !validParameters(item.inputs) || (item.type === "function" && !validParameters(item.outputs)))) return null;
  return items as Abi;
}

export async function fetchVerifiedQuoteAbi(base: string, address: string, signal: AbortSignal): Promise<VerifiedAbi | null> {
  if (!base || !addressPattern.test(address)) return null;
  const url = new URL(base, window.location.origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  // Request metadata only for the observed code address, never the explorer's
  // current proxy implementation, which can differ from the captured execution.
  url.pathname = url.pathname.replace(/\/$/, "") + "/api";
  url.search = new URLSearchParams({ module: "contract", action: "getsourcecode", address }).toString();
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  if (!response.ok) throw new Error(`Explorer HTTP ${response.status}`);
  const body = JSON.parse(await boundedText(response, MAX_ABI_BYTES));
  if (body.status !== "1" || !Array.isArray(body.result)) return null;
  const contract = body.result[0];
  if (!contract || !contract.SourceCode) return null;
  let raw;
  try { raw = typeof contract.ABI === "string" ? JSON.parse(contract.ABI) : contract.ABI; } catch { return null; }
  const abi = safeAbi(raw);
  return abi ? { abi, name: typeof contract.ContractName === "string" ? contract.ContractName.slice(0, 256) : undefined } : null;
}

function canonicalType(parameter: AbiParameter): string {
  return parameter.type.startsWith("tuple") && "components" in parameter
    ? `(${parameter.components.map(canonicalType).join(",")})${parameter.type.slice(5)}` : parameter.type;
}

function signature(item: { name: string; inputs: readonly AbiParameter[] }) {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

function display(value: unknown) {
  const text = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
  return text.length <= 24_000 ? text : text.slice(0, 24_000) + "\n[Display shortened; inspect the raw bytes.]";
}

function decodeParameters(parameters: readonly AbiParameter[], data: Hex) {
  const values = decodeAbiParameters(parameters, data);
  return display(parameters.map((parameter, i) => ({ name: parameter.name || `arg${i}`, type: canonicalType(parameter), value: values[i] })));
}

const selectorCache = new WeakMap<VerifiedAbi, Map<string, (AbiFunction | AbiError)[]>>();
function candidates(contract: VerifiedAbi, selector: string) {
  let index = selectorCache.get(contract);
  if (!index) {
    index = new Map();
    // One ABI can describe thousands of frames; compute its signatures once.
    // Keep collisions as multiple candidates instead of choosing a name.
    for (const item of contract.abi) {
      if (item.type !== "function" && item.type !== "error") continue;
      const key = toFunctionSelector(signature(item)).toLowerCase();
      index.set(key, [...(index.get(key) ?? []), item]);
    }
    selectorCache.set(contract, index);
  }
  return index.get(selector.toLowerCase()) ?? [];
}

export function decodeQuoteFrame(frame: QuoteFrame, contract: VerifiedAbi | null): DecodedQuoteFrame {
  const decoded: DecodedQuoteFrame = { id: frame.id, name: contract?.name,
    note: contract ? "Explorer-verified ABI · historical code match not checked" : "Verified ABI unavailable; showing captured bytes." };
  if (!contract) return decoded;
  if (frame.kind.startsWith("CREATE")) { decoded.note += ". Constructor decoding is unavailable."; return decoded; }
  const functions = candidates(contract, frame.input.hex.slice(0, 10)).filter((item): item is AbiFunction => item.type === "function");
  const method = functions.length === 1 ? functions[0] : undefined;
  if (method) {
    decoded.method = method.name; decoded.signature = signature(method);
    if (frame.input.truncated) decoded.note += ". Input is truncated; arguments were not decoded.";
    else {
      try { decoded.arguments = decodeParameters(method.inputs, `0x${frame.input.hex.slice(10)}`); }
      catch { decoded.note += ". Arguments do not decode with this ABI."; }
    }
    if (frame.status === "success" && frame.output && !frame.output.truncated) {
      try { decoded.returns = decodeParameters(method.outputs, frame.output.hex); }
      catch { decoded.note += frame.output.length === 0 ? ". Call returned no data despite declared return values." : ". Return data does not decode with this ABI."; }
    }
  } else decoded.note += ". Function selector is unknown or ambiguous.";
  if (frame.status === "revert" && frame.output && !frame.output.truncated) {
    const errors = candidates(contract, frame.output.hex.slice(0, 10)).filter(item => item.type === "error");
    const error = errors.length === 1 ? errors[0] : undefined;
    if (error?.type === "error") {
      try { decoded.error = `${signature(error)}\n${decodeParameters(error.inputs, `0x${frame.output.hex.slice(10)}`)}`; }
      catch { /* Keep malformed or incomplete revert bytes as evidence. */ }
    }
  }
  return decoded;
}

/** Four requests at a time; at most 128 distinct code addresses in one selected
 * run. Completion is incremental and obsolete runs stop scheduling work. */
export async function decodeQuoteRun(run: QuoteRun, configured: { l1: string | null; l2: string | null }, explorers: { l1: string; l2: string },
  signal: AbortSignal, onFrames: (frames: DecodedQuoteFrame[]) => void) {
  const groups = new Map<string, { chain: "l1" | "l2"; address: string; frames: QuoteFrame[] }>();
  let unavailable = 0, verified = 0, skipped = 0;
  for (const frame of run.frames) {
    const chain = quoteChain(frame.chainId, configured), address = frame.codeAddress;
    if (!chain || !address || frame.kind.startsWith("CREATE")) { unavailable++; continue; }
    const key = `${chain}:${address.toLowerCase()}`;
    let group = groups.get(key);
    if (!group && groups.size < 128) { group = { chain, address, frames: [] }; groups.set(key, group); }
    if (group) group.frames.push(frame); else { unavailable++; skipped++; }
  }
  const pending = [...groups.values()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (!signal.aborted) {
      const group = pending[next++]; if (!group) return;
      let contract: VerifiedAbi | null = null;
      try { contract = await fetchVerifiedQuoteAbi(explorers[group.chain], group.address, signal); }
      catch { /* Raw evidence remains usable when verification services fail. */ }
      if (signal.aborted) return;
      if (contract) verified++; else unavailable += group.frames.length;
      for (const frame of group.frames) {
        // One bounded annotation per message avoids a large repeated-ABI payload.
        try { onFrames([decodeQuoteFrame(frame, contract)]); }
        catch { onFrames([{ id: frame.id, note: "ABI decoding unavailable; inspect the captured bytes." }]); }
      }
    }
  }));
  return `${verified} verified contract ABI${verified === 1 ? "" : "s"} loaded. ${unavailable} call${unavailable === 1 ? "" : "s"} without a verified ABI.${skipped ? ` ${skipped} calls exceed the 128-contract lookup limit.` : ""} Explorer metadata does not prove the historical code match.`;
}
