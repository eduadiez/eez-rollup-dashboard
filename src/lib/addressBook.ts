/**
 * Address book — maps known addresses to human-readable labels.
 * Populated at startup from runtime config and known dev accounts.
 */

const book = new Map<string, { label: string; chain?: "l1" | "l2" }>();

/** Register a known address. */
export function registerAddress(address: string, label: string, chain?: "l1" | "l2") {
  if (!address) return;
  book.set(`${chain || "any"}:${address.toLowerCase()}`, { label, chain });
}

/** Look up a label for an address. Returns undefined if unknown. */
export function lookupAddress(address: string): string | undefined {
  return lookupAddressForChain(address) || book.get(`l1:${address.toLowerCase()}`)?.label || book.get(`l2:${address.toLowerCase()}`)?.label;
}

/** Look up with chain context. */
export function lookupAddressForChain(address: string, chain?: "l1" | "l2"): string | undefined {
  return (chain ? book.get(`${chain}:${address.toLowerCase()}`)?.label : undefined) || book.get(`any:${address.toLowerCase()}`)?.label;
}

// ─── Hardcoded well-known dev accounts ───

registerAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "Composer (dev#0)");
registerAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "TxSender (dev#1)");
registerAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "Recipient (dev#2)");
registerAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906", "Recipient (dev#3)");
registerAddress("0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "DemoUser (dev#4)");
registerAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", "ComplexTx (dev#5)");

/** Register the resolved protocol addresses, including URL overrides. */
export function registerConfiguredContracts(addresses: {
  rollupsAddress: string; ccmL2Address: string; l1Bridge: string; l2Bridge: string;
}) {
  registerAddress(addresses.rollupsAddress, "Rollups", "l1");
  registerAddress(addresses.ccmL2Address, "CCM (L2)", "l2");
  registerAddress(addresses.l1Bridge, "Bridge (L1)", "l1");
  registerAddress(addresses.l2Bridge, "Bridge (L2)", "l2");
}
