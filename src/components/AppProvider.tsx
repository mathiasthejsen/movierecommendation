"use client";

import type { Session } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadArtifactCurators, loadCatalog, loadMeta } from "@/lib/artifact";
import { BASE_PATH } from "@/lib/config";
import { flush, setTitleLookup, syncNow, useStore } from "@/lib/store";
import { getSupabase } from "@/lib/supabase";
import type { CuratorPick, Meta, Title, TitleKey } from "@/lib/types";

interface AppData {
  ready: boolean;
  error: string | null;
  meta: Meta | null;
  catalog: Map<TitleKey, Title>;
  artifactPicks: CuratorPick[];
  session: Session | null;
  getTitle: (key: TitleKey) => Title | undefined;
}

const Ctx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [catalog, setCatalog] = useState<Map<TitleKey, Title>>(new Map());
  const [artifactPicks, setArtifactPicks] = useState<CuratorPick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const snapshots = useStore((s) => s.titles);

  useEffect(() => {
    Promise.all([loadMeta(), loadCatalog(), loadArtifactCurators()])
      .then(([m, c, cur]) => {
        setMeta(m);
        setCatalog(c);
        setArtifactPicks(cur.picks ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void syncNow();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (s && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) void syncNow();
    });
    const onOnline = () => void flush();
    const onVisible = () => document.visibilityState === "visible" && void syncNow();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` }).catch(() => undefined);
    }
  }, []);

  const value = useMemo<AppData>(() => {
    const getTitle = (key: TitleKey) => catalog.get(key) ?? snapshots[key];
    return { ready: Boolean(meta), error, meta, catalog, artifactPicks, session, getTitle };
  }, [meta, catalog, artifactPicks, error, session, snapshots]);

  useEffect(() => setTitleLookup(value.getTitle), [value.getTitle]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
