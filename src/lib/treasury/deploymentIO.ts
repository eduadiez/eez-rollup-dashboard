import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { Chain, DeploymentArtifacts, DeploymentPending, DeploymentTarget } from "./deployment.ts";
import { matchesRuntime } from "./runtimeCode.ts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const quantity = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-f]+$/i.test(value);
const RECOVERY_BLOCKS = 512n;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)", "function transferFrom(address,address,uint256) returns (bool)",
]);
const registryAbi = parseAbi([
  "function getOrCreateCrossChainProxy(address,uint64) returns (address)",
  "function computeCrossChainProxyAddress(address,uint64) view returns (address)",
  "function authorizedProxies(address) view returns (bool,address,uint64)",
]);
/** Shared contract reads and transaction discovery for both setup networks.
 * Callers own network validation, wallet authorization and canonical receipt
 * verification before advancing their separate deployment journals.
 */
export class DeploymentIO {
  readonly target: DeploymentTarget;
  readonly artifacts: DeploymentArtifacts;
  private recoveryLookup?: { key: string; hash?: Hex };
  constructor(target: DeploymentTarget, artifacts: DeploymentArtifacts) {
    this.target = target; this.artifacts = artifacts;
    check(artifacts.version === 1 && artifacts.core === "855fe0602484750861b4c31502a1a91355d33ed6"
      && artifacts.safe === "bf943f80fec5ac647159d26161446ac5d716a294"
      && artifacts.modules === "c95f03900bff99be090dadb9de1c74b162365485", "Unexpected treasury deployment artifacts");
  }
  async rpc<T>(chain: Chain, method: string, params: unknown[] = [], front = false): Promise<T> {
    const response = await fetch(front ? this.target[chain].front : this.target[chain].rpc, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    check(response.ok, `Deployment RPC HTTP ${response.status}`);
    const body = await response.json(); if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  abi(name: string) { return name === "ERC20" ? erc20Abi : name === "Registry" ? registryAbi : this.artifacts.contracts[name]!.abi; }
  async read<T>(chain: Chain, address: Address, artifact: string, method: string, args: unknown[] = [], tag = "latest"): Promise<T> {
    const abi = this.abi(artifact);
    const data = await this.rpc<Hex>(chain, "eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName: method, args }) }, tag]);
    return decodeFunctionResult({ abi, functionName: method, data }) as T;
  }
  runtimeMatches(code: Hex, name: string) { return matchesRuntime(code, this.artifacts.contracts[name]!); }
  /** Discover a missing or repriced hash without resubmitting. The sender's
   * historical nonce narrows a bounded canonical-block window to one block. A hash
   * is only a tracking hint; reconcile still verifies canonical execution.
   */
  async trackPending<T extends { pending?: DeploymentPending }>(state: T): Promise<T> {
    const pending = state.pending; if (!pending) return state;
    if (pending.hash && await this.rpc(pending.chain, "eth_getTransactionReceipt", [pending.hash])) return state;
    const head = await this.rpc<{ number: Hex; hash: Hex } | null>(pending.chain, "eth_getBlockByNumber", ["latest", false]);
    check(head && quantity(head.number) && digest(head.hash), "The network's current block is unavailable. Automatic tracking will retry.");
    const key = [pending.chain, pending.sender.toLowerCase(), pending.nonce, pending.to?.toLowerCase(), keccak256(pending.data), head.hash].join(":");
    let hash: Hex | undefined;
    if (this.recoveryLookup?.key === key) hash = this.recoveryLookup.hash;
    else {
      const nonceAt = async (number: bigint) => {
        const value = await this.rpc<Hex>(pending.chain, "eth_getTransactionCount", [pending.sender, toHex(number)]);
        check(quantity(value), "The network's transaction history is unavailable. Automatic tracking will retry.");
        return BigInt(value);
      };
      let high = BigInt(head.number);
      let low = high > RECOVERY_BLOCKS ? high - RECOVERY_BLOCKS : 0n;
      const nonce = BigInt(pending.nonce);
      if (await nonceAt(high) > nonce && await nonceAt(low) <= nonce) {
        // Search only while the lower block precedes consumption and the upper
        // block includes it. Never infer transaction success from account nonce.
        while (high - low > 1n) {
          const middle = (high + low) / 2n;
          if (await nonceAt(middle) > nonce) high = middle; else low = middle;
        }
        type Transaction = { hash: Hex; from: Address; to: Address | null; input: Hex; nonce: Hex; value: Hex };
        const block = await this.rpc<{ number: Hex; hash: Hex; transactions: Transaction[] } | null>(pending.chain, "eth_getBlockByNumber", [toHex(high), true]);
        check(block && quantity(block.number) && BigInt(block.number) === high && digest(block.hash) && Array.isArray(block.transactions),
          "The network's transaction history is unavailable. Automatic tracking will retry.");
        const tx = block.transactions.find(tx => tx && isAddress(tx.from) && same(tx.from, pending.sender) && quantity(tx.nonce) && BigInt(tx.nonce) === nonce);
        if (tx) {
          check(digest(tx.hash) && (pending.to ? tx.to !== null && isAddress(tx.to) && same(tx.to, pending.to) : tx.to === null)
            && typeof tx.input === "string" && same(tx.input, pending.data) && quantity(tx.value) && BigInt(tx.value) === 0n,
          "This wallet nonce was used for a different transaction. Setup has not advanced.");
          hash = tx.hash;
        }
      }
      // A reorg changes the head hash and invalidates this lookup. Do not
      // cache failed RPCs or mismatches; neither establishes a completed search.
      const current = await this.rpc<{ hash: Hex } | null>(pending.chain, "eth_getBlockByNumber", [head.number, false]);
      if (current?.hash !== head.hash) return state;
      this.recoveryLookup = { key, hash };
    }
    return hash && hash !== pending.hash ? { ...state, pending: { ...pending, hash } } : state;
  }
}
