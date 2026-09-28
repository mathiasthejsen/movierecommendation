"use client";

import { useMemo } from "react";
import { curatorWeights, ENABLED_CURATORS } from "@/lib/curators";
import { activePicks, useStore } from "@/lib/store";
import type { CuratorPick } from "@/lib/types";
import { useApp } from "./AppProvider";

/** All curator picks: pipeline (Letterboxd/Instagram) + family shares from Supabase/local. */
export function useAllPicks(): { picks: CuratorPick[]; weights: Map<string, number> } {
  const { artifactPicks } = useApp();
  const userPicks = useStore(activePicks);
  return useMemo(() => {
    const enabled = new Set(ENABLED_CURATORS.map((c) => c.handle));
    const fromUsers: CuratorPick[] = userPicks.map((p) => ({ key: p.key, curator: p.curator, source: p.source, url: p.postUrl, weight: 1 }));
    const picks = [...artifactPicks.filter((p) => enabled.has(p.curator)), ...fromUsers];
    return { picks, weights: curatorWeights(fromUsers.map((p) => p.curator)) };
  }, [artifactPicks, userPicks]);
}
