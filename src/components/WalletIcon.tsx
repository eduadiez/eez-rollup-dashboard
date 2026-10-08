import rabbyIcon from "../styles/brand/rabby-icon.svg";
import metamaskIcon from "../styles/brand/metamask-icon.svg";

/** Decorative, locally served marks; the adjacent wallet name supplies the label. */
export function WalletIcon({ name, className }: { name: string | null; className?: string }) {
  const brand = /^rabby(?: wallet)?$/i.test(name ?? "") ? "rabby" :
    /^metamask(?: wallet)?$/i.test(name ?? "") ? "metamask" : null;
  return brand ? <img src={brand === "rabby" ? rabbyIcon : metamaskIcon} alt="" aria-hidden="true"
    data-wallet-logo={brand} className={className} /> :
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className={className}>
      <path d="M4 6h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13v2M20 10h-6v6h6M16 13h1" />
    </svg>;
}
