import { useState, useEffect, useCallback, useId } from "react";
import styles from "./GasLimitEditor.module.css";

const MIN_GAS = 21_000;
const MAX_GAS = 60_000_000; // block gas limit
const LOW_GAS_THRESHOLD = 0.7; // warn if custom < 70% of estimate

interface Props {
  /** Estimated gas limit (raw estimate, before buffer) — null if not yet estimated */
  estimatedGas: number | null;
  /** Requested limit; bridge estimates are raw, other callers may apply a buffer. */
  estimatedGasWithBuffer: number | null;
  /** Whether estimation is in progress */
  estimating: boolean;
  /** Called with the gas hex string to use, or null to use the estimate */
  onGasOverride: (gasHex: string | null) => void;
  /** Whether the parent form is busy / disabled */
  disabled?: boolean;
}

export function GasLimitEditor({
  estimatedGas,
  estimatedGasWithBuffer,
  estimating,
  onGasOverride,
  disabled,
}: Props) {
  const inputId = useId();
  const [customValue, setCustomValue] = useState("");
  const [useCustom, setUseCustom] = useState(false);

  // When estimate changes, reset custom if user hasn't touched it
  useEffect(() => {
    if (!useCustom && estimatedGasWithBuffer !== null) {
      setCustomValue(estimatedGasWithBuffer.toString());
    }
  }, [estimatedGasWithBuffer, useCustom]);

  // Notify parent of override changes
  useEffect(() => {
    if (!useCustom || !customValue) {
      onGasOverride(null);
      return;
    }
    const parsed = parseInt(customValue, 10);
    if (!isNaN(parsed) && parsed >= MIN_GAS && parsed <= MAX_GAS) {
      onGasOverride("0x" + parsed.toString(16));
    } else {
      onGasOverride(null);
    }
  }, [useCustom, customValue, onGasOverride]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9]/g, "");
    setCustomValue(val);
    setUseCustom(true);
  }, []);

  // Validation
  const parsed = parseInt(customValue, 10);
  const isValid = !customValue || (!isNaN(parsed) && parsed >= MIN_GAS && parsed <= MAX_GAS);
  const isBelowEstimate =
    useCustom &&
    !isNaN(parsed) &&
    estimatedGas !== null &&
    parsed < estimatedGas * LOW_GAS_THRESHOLD;
  const isAboveMax = !isNaN(parsed) && parsed > MAX_GAS;
  const isBelowMin = !isNaN(parsed) && parsed >= 0 && parsed < MIN_GAS;

  return (
    <div className={styles.container}>
      <div className={styles.panel}>
        <div className={styles.estimateRow}>
          <span className={styles.estimateLabel}>Estimated gas</span>
          <span className={styles.estimateValue} aria-live="polite">
            {estimating ? <span className={styles.estimatingText}><span className={styles.spinner} />Estimating...</span> :
              estimatedGas !== null ? estimatedGas.toLocaleString() : "—"}
          </span>
        </div>
        <div className={styles.inputSection}>
          <label className={styles.inputLabel} htmlFor={inputId}>Gas limit</label>
          <input
            id={inputId}
            type="text"
            inputMode="numeric"
            className={`${styles.input} ${!isValid ? styles.inputError : ""}`}
            value={customValue}
            onChange={handleInputChange}
            placeholder={estimatedGasWithBuffer?.toLocaleString() || "Enter gas limit"}
            disabled={disabled}
            aria-invalid={!isValid || undefined}
            aria-describedby={!isValid || isBelowEstimate ? `${inputId}-feedback` : undefined}
          />
          {isBelowMin && <div id={`${inputId}-feedback`} className={styles.validationError}>
            Minimum gas limit is {MIN_GAS.toLocaleString()}
          </div>}
          {isAboveMax && <div id={`${inputId}-feedback`} className={styles.validationError}>
            Maximum gas limit is {MAX_GAS.toLocaleString()} (block gas limit)
          </div>}
          {isBelowEstimate && !isBelowMin && !isAboveMax && <div id={`${inputId}-feedback`} className={styles.validationWarning}>
            Below estimated gas ({estimatedGas!.toLocaleString()}) — transaction may fail
          </div>}
        </div>
      </div>
    </div>
  );
}
