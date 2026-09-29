"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getFamily, refreshFamily } from "@/lib/family";
import { addToWatchlist, getState, toggleWatchlist } from "@/lib/store";
import { detectMatch, matchMessage, otherMembers } from "@/lib/together";
import type { Title, TitleKey } from "@/lib/types";
import { useApp } from "./AppProvider";
import { Poster } from "./TitleCard";

/**
 * Every watchlist add in the app goes through here (see useWatchlistActions), so an
 * "It's a match" sheet appears whenever you add something a family member already has.
 * The check uses the cached family watchlists (instant, works offline); if that cache is
 * older than ~60 s it's refreshed in the background and checked again.
 */

export interface WatchlistActions {
  /** Add or remove (TitleCard's watchlist button). */
  toggle: (key: TitleKey, title?: Title) => void;
  /** Add only ("+ Add to mine" on a family member's list). */
  add: (key: TitleKey, title?: Title) => void;
}

const Ctx = createContext<WatchlistActions | null>(null);
const STALE_MS = 60_000;
const SWIPE_CLOSE_PX = 80;

export function useWatchlistActions(): WatchlistActions {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWatchlistActions must be used inside <MatchSheetProvider>");
  return v;
}

function isMine(key: TitleKey): boolean {
  const w = getState().watchlist[key];
  return Boolean(w && !w.deleted);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

interface Match {
  key: TitleKey;
  title: Title;
  names: string[];
  /** Bumped on every match so replacing content re-announces it. */
  id: number;
}

export function MatchSheetProvider({ children }: { children: ReactNode }) {
  const { session, getTitle } = useApp();
  const router = useRouter();
  const [match, setMatch] = useState<Match | null>(null);
  const counter = useRef(0);
  const meId = session?.user.id ?? null;

  const namesFor = useCallback(
    (key: TitleKey): string[] => {
      const fam = getFamily();
      if (!meId || fam.meId !== meId) return [];
      return detectMatch(key, false, otherMembers(fam.profiles, fam.items, meId), fam.items).map((m) => m.name);
    },
    [meId],
  );

  const show = useCallback((key: TitleKey, title: Title, names: string[]) => {
    counter.current += 1;
    setMatch({ key, title, names, id: counter.current }); // replaces any open sheet's content
    if (!prefersReducedMotion()) navigator.vibrate?.(30);
  }, []);

  const checkMatch = useCallback(
    async (key: TitleKey, title?: Title) => {
      if (!meId) return;
      const t = title ?? getTitle(key);
      if (!t) return;
      const names = namesFor(key);
      if (names.length) {
        show(key, t, names);
        return;
      }
      const fam = getFamily();
      const stale = !fam.fetchedAt || Date.now() - Date.parse(fam.fetchedAt) > STALE_MS;
      if (!stale) return;
      await refreshFamily();
      const fresh = namesFor(key);
      if (fresh.length && isMine(key)) show(key, t, fresh);
    },
    [meId, getTitle, namesFor, show],
  );

  // Keep the family cache warm while the app is open, so the check is usually instant.
  useEffect(() => {
    if (!meId) return;
    const tick = () => {
      const fam = getFamily();
      if (document.visibilityState === "visible" && (!fam.fetchedAt || Date.now() - Date.parse(fam.fetchedAt) > STALE_MS)) void refreshFamily();
    };
    const timer = window.setInterval(tick, STALE_MS);
    return () => window.clearInterval(timer);
  }, [meId]);

  const actions = useMemo<WatchlistActions>(
    () => ({
      toggle: (key, title) => {
        const wasMine = isMine(key);
        toggleWatchlist(key, title);
        if (!wasMine) void checkMatch(key, title); // no popup when removing
      },
      add: (key, title) => {
        const wasMine = isMine(key);
        addToWatchlist(key, title);
        if (!wasMine) void checkMatch(key, title); // no popup if it was already mine
      },
    }),
    [checkMatch],
  );

  const close = useCallback(() => setMatch(null), []);
  const seeTogether = useCallback(() => {
    const key = match?.key;
    setMatch(null);
    if (key) router.push(`/watchlist/?tab=together&highlight=${encodeURIComponent(key)}`);
  }, [match, router]);

  return (
    <Ctx.Provider value={actions}>
      {children}
      {match ? <MatchSheet match={match} onClose={close} onSeeTogether={seeTogether} /> : null}
    </Ctx.Provider>
  );
}

function MatchSheet({ match, onClose, onSeeTogether }: { match: Match; onClose: () => void; onSeeTogether: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ startY: number; dy: number } | null>(null);

  // Focus the primary action; return focus to where it was when the sheet closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  // New content while open: move focus back to the primary action.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [match.id]);

  // Esc closes; Tab stays inside the sheet; the page behind doesn't scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && sheetRef.current) {
        const focusable = [...sheetRef.current.querySelectorAll<HTMLElement>("button")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Swipe down to close (bottom-sheet layout).
  const setDrag = (px: number) => sheetRef.current?.style.setProperty("--drag", `${Math.max(0, px)}px`);
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, dy: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.dy = e.clientY - drag.current.startY;
    if (drag.current.dy > 4) setDrag(drag.current.dy);
  };
  const onPointerEnd = () => {
    const dy = drag.current?.dy ?? 0;
    drag.current = null;
    if (dy > SWIPE_CLOSE_PX) onClose();
    else setDrag(0);
  };

  return (
    <div className="match-backdrop" onClick={onClose} data-testid="match-backdrop">
      <div
        ref={sheetRef}
        className="match-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-heading"
        aria-describedby="match-message"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div className="sheet-handle" aria-hidden />
        <div className="match-body" key={match.id}>
          <div className="match-poster">
            <Poster title={match.title} size="w185" />
          </div>
          <div>
            <h2 id="match-heading">It&apos;s a match!</h2>
            <p className="match-title">{match.title.title}</p>
            <p id="match-message" className="match-message" aria-live="polite">
              {matchMessage(match.names)}
            </p>
          </div>
        </div>
        <div className="match-actions">
          <button ref={primaryRef} type="button" className="btn" onClick={onSeeTogether}>
            See Together
          </button>
          <button type="button" className="btn secondary" onClick={onClose}>
            Nice
          </button>
        </div>
      </div>
    </div>
  );
}
