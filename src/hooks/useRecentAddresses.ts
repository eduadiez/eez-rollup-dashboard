import { useCallback, useEffect, useState } from "react";

const MAX_ENTRIES = 8;

function load(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function useRecentAddresses(chain: "l1" | "l2" = "l2") {
  const storageKey = chain === "l2" ? "recentL2Addresses" : "recentL1Addresses";
  const [addresses, setAddresses] = useState<string[]>(() => load(storageKey));
  useEffect(() => { setAddresses(load(storageKey)); }, [storageKey]);

  const addAddress = useCallback((addr: string) => {
    const normalized = addr.trim().toLowerCase();
    if (!normalized || !/^0x[0-9a-f]{40}$/i.test(normalized)) return;
    setAddresses((prev) => {
      const filtered = prev.filter((a) => a !== normalized);
      const updated = [normalized, ...filtered].slice(0, MAX_ENTRIES);
      localStorage.setItem(storageKey, JSON.stringify(updated));
      return updated;
    });
  }, [storageKey]);

  const clear = useCallback(() => {
    setAddresses([]);
    localStorage.removeItem(storageKey);
  }, [storageKey]);

  return { addresses, addAddress, clear };
}
