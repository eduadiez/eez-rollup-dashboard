import { config } from "../config";
import ethereumIcon from "../styles/brand/ethereum-icon.svg";
import gnosisIcon from "../styles/brand/gnosis-icon.svg";
import eezIcon from "../styles/brand/eez-icon.svg";
import styles from "./NetworkIcon.module.css";

/** Shared deployment-aware network mark for transfers and header telemetry. */
export function NetworkIcon({ chain, className = "", decorative = false }: {
  chain: "l1" | "l2";
  className?: string;
  decorative?: boolean;
}) {
  const l1 = chain === "l1";
  const gnosis = l1 && !config.l1NetworkLogoUrl && config.l1NetworkLogo === "gnosis";
  const logo = l1 ? (config.l1NetworkLogoUrl || (config.l1NetworkLogo === "ethereum" ? ethereumIcon : gnosis ? gnosisIcon : null)) : eezIcon;
  const classes = `${styles.icon} ${gnosis ? styles.gnosis : ""} ${className}`;
  return logo ? <img className={classes} src={logo} alt={decorative ? "" : l1 ? config.l1NetworkName : "EEZ"} aria-hidden={decorative || undefined} /> :
    <svg className={classes} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2 22 7v10l-10 5-10-5V7zM2 7l10 5 10-5M12 12v10" /></svg>;
}
