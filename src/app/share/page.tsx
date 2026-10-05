"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { CuratorInput, isValidHandle } from "@/components/CuratorInput";
import { Poster, TypeBadge } from "@/components/TitleCard";
import { SearchingHint, SearchStatus, useTitleSearch } from "@/components/TitleSearch";
import { CURATORS, curatorAliases } from "@/lib/curators";
import { detectCurator, extractCaption, parseSharedUrl, type Candidate } from "@/lib/extract";
import { bestMatch } from "@/lib/match";
import { searchCatalog } from "@/lib/search";
import { addPicks, getState } from "@/lib/store";
import { proxyDetails, proxySearch } from "@/lib/tmdbProxy";
import type { Title } from "@/lib/types";

interface Row {
  cand: Candidate;
  match: Title | null;
  checked: boolean;
  seed: boolean;
}

/**
 * PWA Web Share Target (GET): manifest share_target -> /share/?title=&text=&url=
 * Only the confirmed TMDB matches, the curator handle and the post URL are saved.
 * The shared caption itself is processed in memory and never stored.
 */
export default function SharePage() {
  const { ready, catalog } = useApp();
  const [shared, setShared] = useState<{ text: string; url: string | null } | null>(null);
  const [curator, setCurator] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState(0);
  const [query, setQuery] = useState("");
  const { all, status, loading } = useTitleSearch(query, "both");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const text = [params.get("title"), params.get("text")].filter(Boolean).join("\n");
    let url = params.get("url");
    // Some apps put the link inside the text instead of the url field.
    if (!url) url = text.match(/https?:\/\/\S+/)?.[0] ?? null;
    setShared({ text, url });
    const handles = CURATORS.map((c) => c.handle);
    setCurator(detectCurator(text, url, handles, curatorAliases()) ?? getState().settings.lastCurator ?? "");
    // Drop the query string so a reload doesn't re-share.
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (!ready || !shared) return;
    let cancelled = false;
    (async () => {
      const { seeds, picks } = extractCaption(shared.text);
      const fromUrl = parseSharedUrl(shared.url);
      const out: Row[] = [];
      if (fromUrl.key) {
        const t = catalog.get(fromUrl.key) ?? (await proxyDetails(fromUrl.key)).data?.title ?? null;
        if (t) out.push({ cand: { title: t.title, year: t.year, kind: t.type }, match: t, checked: true, seed: false });
      }
      const cands: [Candidate, boolean][] = [...picks.map((c) => [c, false] as [Candidate, boolean]), ...seeds.map((c) => [c, true] as [Candidate, boolean])];
      if (fromUrl.candidate) cands.unshift([fromUrl.candidate, false]);
      for (const [cand, seed] of cands.slice(0, 20)) {
        const live = await proxySearch(cand.title, cand.kind ?? "multi", cand.year ?? undefined);
        const pool = live.status === "ok" && live.data ? live.data.results : searchCatalog(catalog.values(), cand.title, { limit: 10 });
        const match = bestMatch(cand, pool.map((t) => catalog.get(t.key) ?? t));
        if (match && out.some((r) => r.match?.key === match.key)) continue;
        out.push({ cand, match, checked: Boolean(match) && !seed, seed });
      }
      if (!cancelled) setRows(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, shared, catalog]);

  const toggle = (i: number) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, checked: !r.checked } : r)));
  const chosen = rows?.filter((r) => r.checked && r.match) ?? [];
  const save = () => {
    if (!isValidHandle(curator) || !chosen.length) return;
    addPicks(chosen.map((r) => ({ title: r.match!, curator, postUrl: shared?.url ?? null, source: "share" as const })));
    setSaved(chosen.length);
  };
  const addManual = (t: Title) => {
    setRows((rs) => [...(rs ?? []), { cand: { title: t.title, year: t.year, kind: t.type }, match: t, checked: true, seed: false }]);
    setQuery("");
  };

  if (!ready || !shared) return <p className="muted">Loading…</p>;
  if (saved) {
    return (
      <>
        <h1>Saved ✓</h1>
        <p>
          Added {saved} pick{saved > 1 ? "s" : ""} from @{curator}.
        </p>
        <div className="row">
          <Link className="btn" href="/picks/">
            View picks
          </Link>
          <Link className="btn secondary" href="/">
            For you
          </Link>
        </div>
      </>
    );
  }
  return (
    <>
      <h1>Add curator picks</h1>
      {!shared.text && !shared.url ? (
        <p className="muted">Nothing was shared. Use Share → Reel Picks on a post, or add picks manually below.</p>
      ) : null}
      {shared.url ? <p className="muted small">From {shared.url}</p> : null}
      <div className="stack">
        <CuratorInput value={curator} onChange={setCurator} />
        {rows === null ? <p className="muted">Finding titles…</p> : null}
        {rows?.length === 0 ? (
          <p className="muted">
            No titles found in what was shared{shared.text ? "" : " (only a link came through)"} — search for them below.
          </p>
        ) : null}
        {rows?.map((r, i) => (
          <label className="match" key={`${r.cand.title}-${i}`}>
            <input type="checkbox" checked={r.checked} disabled={!r.match} onChange={() => toggle(i)} />
            {r.match ? <Poster title={r.match} size="w185" /> : null}
            <div className="grow">
              {r.match ? (
                <>
                  <strong>{r.match.title}</strong> <TypeBadge title={r.match} /> <span className="muted small">{r.match.year}</span>
                </>
              ) : (
                <span className="muted">No match for “{r.cand.title}”</span>
              )}
              {r.seed ? <div className="muted small">Mentioned as the reference title</div> : null}
            </div>
          </label>
        ))}
        <input type="search" placeholder="Missing one? Search to add it…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <SearchStatus status={status} />
        {all.slice(0, 5).map((t) => (
          <div className="match" key={t.key}>
            <Poster title={t} size="w185" />
            <div className="grow">
              <strong>{t.title}</strong> <TypeBadge title={t} /> <span className="muted small">{t.year}</span>
            </div>
            <button type="button" className="chip" onClick={() => addManual(t)}>
              + Add
            </button>
          </div>
        ))}
        {query.trim().length >= 2 ? <SearchingHint loading={loading} status={status} /> : null}
        <button type="button" className="btn" disabled={!chosen.length || !isValidHandle(curator)} onClick={save}>
          Save {chosen.length || ""} pick{chosen.length === 1 ? "" : "s"}
          {curator ? ` from @${curator}` : ""}
        </button>
      </div>
    </>
  );
}
