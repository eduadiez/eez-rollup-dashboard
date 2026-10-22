import { getAddress, isAddress, keccak256, zeroAddress } from "viem";
import type { Address, Hex } from "viem";
import type { TreasuryDeployment } from "./deployment.ts";
import { discoverSharedInfrastructure } from "./sharedInfrastructure.ts";
import profile from "./shared-network.json" with { type: "json" };

/** Existing network assets are verified independently of any test faucet API. */
export type AssetInfrastructure = {
  tokenL1: Address; tokenL2: Address; bridgeL1: Address; bridgeL2: Address;
  tokenCodeHash: Hex;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
export function validAssetBinding(value: AssetInfrastructure) {
  return value && [value.tokenL1, value.tokenL2, value.bridgeL1, value.bridgeL2].every(a => isAddress(a) && a !== zeroAddress)
    && /^0x[\da-f]{64}$/i.test(value.tokenCodeHash);
}
type Block = { number: Hex; hash: Hex };
export async function verifyAssetInfrastructure(d: TreasuryDeployment, asset: AssetInfrastructure) {
  check(validAssetBinding(asset), "Invalid treasury asset configuration");
  const blocks = await Promise.all((["l1", "l2"] as const).map(chain => d.rpc<Block>(chain, "eth_getBlockByNumber", ["safe", false])));
  check(blocks.every(Boolean), "Treasury asset confirmation is unavailable");
  for (const [index, chain] of (["l1", "l2"] as const).entries()) {
    const tag = blocks[index]!.number, bridge = chain === "l1" ? asset.bridgeL1 : asset.bridgeL2;
    check(d.runtimeMatches(await d.rpc<Hex>(chain, "eth_getCode", [bridge, tag]), "SharedTreasuryBridge"), "Treasury bridge code mismatch");
    const read = <T>(name: string) => d.read<T>(chain, bridge, "SharedTreasuryBridge", name, [], tag);
    const [token, manager, local, rollup, admin, peer] = await Promise.all([
      read<Address>("canonicalToken"), read<Address>("manager"), read<bigint>("rollupId"), read<bigint>("treasuryRollupId"), read<Address>("admin"), read<Address>("canonicalBridgeAddress"),
    ]);
    check(same(token, asset.tokenL1) && same(manager, chain === "l1" ? profile.registry : profile.manager)
      && local === (chain === "l1" ? 0n : BigInt(profile.rollupId)) && rollup === BigInt(profile.rollupId)
      && admin === zeroAddress && same(peer, chain === "l1" ? asset.bridgeL2 : asset.bridgeL1), "Treasury bridge configuration is not sealed or does not match this network");
  }
  const [l1, l2] = blocks;
  const code = await d.rpc<Hex>("l1", "eth_getCode", [asset.tokenL1, l1!.number]);
  check(code !== "0x" && keccak256(code) === asset.tokenCodeHash, "Treasury asset code changed");
  check(Number(await d.read<number>("l1", asset.tokenL1, "ERC20", "decimals", [], l1!.number)) === 6, "Treasury requires a six-decimal asset");
  const [wrapped, origin, authority, decimals] = await Promise.all([
    d.read<Address>("l2", asset.bridgeL2, "SharedTreasuryBridge", "getWrappedToken", [asset.tokenL1, 0n], l2!.number),
    d.read<[Address, bigint]>("l2", asset.bridgeL2, "SharedTreasuryBridge", "wrappedTokenInfo", [asset.tokenL2], l2!.number),
    d.read<Address>("l2", asset.tokenL2, "WrappedToken", "BRIDGE", [], l2!.number),
    d.read<number>("l2", asset.tokenL2, "ERC20", "decimals", [], l2!.number),
  ]);
  check(same(wrapped, asset.tokenL2) && same(origin[0], asset.tokenL1) && origin[1] === 0n
    && same(authority, asset.bridgeL2) && Number(decimals) === 6, "Treasury wrapped asset mapping mismatch");
  check(d.runtimeMatches(await d.rpc<Hex>("l2", "eth_getCode", [asset.tokenL2, l2!.number]), "WrappedToken"), "Treasury wrapped asset code mismatch");
  for (const [index, chain] of (["l1", "l2"] as const).entries())
    check((await d.rpc<Block>(chain, "eth_getBlockByNumber", [blocks[index]!.number, false]))?.hash === blocks[index]!.hash, "Treasury asset verification changed; retry");
}

/** The testnet registry locates predeployed infrastructure. The resulting
 * funding plan uses only ERC-20 calls; it never deploys or claims an asset.
 */
export async function discoverAssetInfrastructure(d: TreasuryDeployment): Promise<AssetInfrastructure | undefined> {
  const shared = await discoverSharedInfrastructure(d);
  if (!shared) return undefined;
  const asset = { tokenL1: getAddress(shared.tokenL1), tokenL2: getAddress(shared.tokenL2), bridgeL1: getAddress(shared.bridgeL1), bridgeL2: getAddress(shared.bridgeL2),
    tokenCodeHash: keccak256(await d.rpc<Hex>("l1", "eth_getCode", [shared.tokenL1, "safe"])) };
  await verifyAssetInfrastructure(d, asset);
  return asset;
}
