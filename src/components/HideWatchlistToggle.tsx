"use client";

import { useCallback, useEffect, useState } from "react";
import { HIDE_WATCHLIST_KEY, loadHideWatchlist, onHideWatchlistChange, setHideWatchlistPref } from "@/lib/prefs";

/**
 * The shared "Hide titles on my watchlist" preference (For you + Picks). Default ON; a change on
 * one page applies to the other (and to other tabs via the storage event).
 */
export function useHideWatchlist(): [boolean, (value: boolean) => void] {
  const [hide, setHide] = useState(true);
  useEffect(() => {
    setHide(loadHideWatchlist(window.localStorage));
    const off = onHideWatchlistChange(setHide);
    const onStorage = (e: StorageEvent) => {
      if (e.key === HIDE_WATCHLIST_KEY) setHide(e.newValue !== "false");
    };
    window.addEventListener("storage", onStorage);
    return () => {
      off();
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const set = useCallback((value: boolean) => setHideWatchlistPref(window.localStorage, value), []);
  return [hide, set];
}

/** Compact checkbox used in the same spot on For you and Picks. */
export function HideWatchlistToggle({
  checked,
  hiddenCount,
  onChange,
}: {
  checked: boolean;
  hiddenCount: number;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="feed-option small muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Hide titles on my watchlist{checked && hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
      </span>
    </label>
  );
}
