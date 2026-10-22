import { decodeEventLog, encodeEventTopics, parseAbi } from "viem";
import type { Hex } from "viem";

const indexed = parseAbi([
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
const legacy = parseAbi([
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
export const safeExecutionTopics = [
  encodeEventTopics({ abi: indexed, eventName: "ExecutionSuccess" })[0]!,
  encodeEventTopics({ abi: indexed, eventName: "ExecutionFailure" })[0]!,
];

/** Safe 1.3.0 stores txHash in data; 1.4.1/1.5.0 index it. Require the exact event
 * shape so malformed or unrelated logs cannot establish execution. Callers must
 * also match the emitting Safe, reviewed hash and canonical receipt identity.
 */
export function decodeSafeExecution(log: { data: Hex; topics: readonly Hex[] }) {
  const abi = log.topics.length === 1 ? legacy : indexed;
  const dataBytes = log.topics.length === 1 ? 64 : 32;
  if (![1, 2].includes(log.topics.length) || !log.topics.every(topic => /^0x[\da-f]{64}$/i.test(topic))
    || !/^0x[\da-f]*$/i.test(log.data) || log.data.length !== 2 + dataBytes * 2) return undefined;
  try {
    return decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  } catch { return undefined; }
}
