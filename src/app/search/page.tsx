"use client";

import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { TitleCard } from "@/components/TitleCard";
import { MediaToggle, SearchingHint, SearchStatus, useTitleSearch, type SearchType } from "@/components/TitleSearch";

export default function SearchPage() {
  const { ready } = useApp();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("both");
  const { results, more, status, loading } = useTitleSearch(query, type);
  if (!ready) return <p className="muted">Loading…</p>;
  return (
    <>
      <h1>Search</h1>
      <div className="stack">
        <input type="search" autoFocus placeholder="Movie or TV show…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <MediaToggle value={type} onChange={setType} />
        <SearchStatus status={status} />
      </div>
      <div className="list" style={{ marginTop: 12 }}>
        {results.map((t) => (
          <TitleCard key={t.key} title={t} />
        ))}
      </div>
      <SearchingHint loading={loading} status={status} />
      {more.length && results.length ? <h2 className="more-results">More results</h2> : null}
      {more.length ? (
        <div className="list">
          {more.map((t) => (
            <TitleCard key={t.key} title={t} />
          ))}
        </div>
      ) : null}
      {query.trim().length >= 2 && !results.length && !more.length && !loading ? <p className="muted">No matches.</p> : null}
    </>
  );
}
