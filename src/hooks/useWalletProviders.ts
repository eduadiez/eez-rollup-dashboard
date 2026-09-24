import { useEffect, useState } from "react";

export interface WalletProviderChoice {
  id: string;
  name: string;
  storageKey: string;
  provider: EthereumProvider;
}

interface AnnouncedProvider {
  info: { uuid: string; name: string; rdns: string };
  provider: EthereumProvider;
}

/** Discover separate injected wallets so transactions use the wallet the user selected. */
export function useWalletProviders(): WalletProviderChoice[] {
  const [announced, setAnnounced] = useState<AnnouncedProvider[]>([]);

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<AnnouncedProvider>).detail;
      if (!detail?.provider?.request || !detail.info?.uuid || !detail.info?.name) return;
      setAnnounced((current) => current.some((item) =>
        item.info.uuid === detail.info.uuid || item.provider === detail.provider,
      ) ? current : [...current, detail]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  if (announced.length > 0) {
    return announced.map(({ info, provider }) => ({
      id: info.uuid,
      name: info.name,
      storageKey: info.rdns || info.uuid,
      provider,
    }));
  }

  // Older extensions may only expose the legacy injected-provider array.
  const legacy = window.ethereum?.providers?.length
    ? window.ethereum.providers : window.ethereum ? [window.ethereum] : [];
  return legacy.map((provider, index) => {
    const name = provider.isRabby ? "Rabby" : provider.isMetaMask ? "MetaMask" : "Browser Wallet";
    return { id: `legacy:${index}`, name, storageKey: `legacy:${index}`, provider };
  });
}
