export function l1Identity(chainId: string): { name: string; logo: "ethereum" | "gnosis" | "generic" } {
  let id: number;
  try { id = Number(BigInt(chainId)); } catch { return { name: "L1 network", logo: "generic" }; }
  switch (id) {
    case 1: return { name: "Ethereum", logo: "ethereum" };
    case 100: return { name: "Gnosis", logo: "gnosis" };
    case 10200: return { name: "Chiado", logo: "gnosis" };
    case 11155111: return { name: "Sepolia", logo: "ethereum" };
    default: return { name: `L1 network (${id})`, logo: "generic" };
  }
}

/** The rollup bridges the deployment’s L1 native asset one-to-one. */
export function nativeCurrency(chainId: string) {
  const id = Number(BigInt(chainId));
  return id === 100 || id === 10200
    ? { name: "xDAI", symbol: "xDAI", decimals: 18 }
    : { name: "Ether", symbol: "ETH", decimals: 18 };
}
