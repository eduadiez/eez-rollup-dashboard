import type { Hex } from "viem";
import type { Artifact } from "./deployment.ts";

export function matchesRuntime(code: Hex, artifact: Artifact) {
  if (code.length !== artifact.runtime.length || code === "0x") return false;
  let normalized = code.toLowerCase(), expected = artifact.runtime.toLowerCase();
  for (const { start, length } of artifact.immutables) {
    const from = 2 + start * 2, to = from + length * 2;
    if (from < 2 || to > code.length) return false;
    normalized = normalized.slice(0, from) + "0".repeat(length * 2) + normalized.slice(to);
    expected = expected.slice(0, from) + "0".repeat(length * 2) + expected.slice(to);
  }
  // A getter and its execution path must contain the same constructor value.
  // Masking each slot independently would accept a forged reused adapter whose
  // getter names the expected Safe while signature checks target another one.
  for (const refs of artifact.immutableGroups ?? []) {
    const values = refs.map(({ start, length }) => code.slice(2 + start * 2, 2 + (start + length) * 2).toLowerCase());
    if (values.some(value => value !== values[0])) return false;
  }
  return normalized === expected;
}
