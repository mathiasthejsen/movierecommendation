"use client";

import { useState } from "react";
import { posterUrl } from "@/lib/config";
import { tmdbUrl } from "@/lib/keys";
import { toggleWatchlist, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";
import { useApp } from "./AppProvider";
import { RatingControl } from "./RatingControl";

export function Poster({ title, size = "w342" }: { title: Title; size?: "w185" | "w342" }) {
  const url = posterUrl(title.poster, size);
  if (!url) {
    return (
      <div className="poster placeholder" aria-hidden>
        <span>{title.title}</span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="poster" src={url} alt="" loading="lazy" decoding="async" />;
}

export function TypeBadge({ title }: { title: Title }) {
  if (title.type !== "tv") return null;
  return <span className="badge tv">TV</span>;
}

export function TitleMeta({ title }: { title: Title }) {
  const { meta } = useApp();
  const genres = title.genres
    .slice(0, 3)
    .map((g) => meta?.genres[String(g)])
    .filter(Boolean)
    .join(", ");
  const bits: string[] = [String(title.year || "")];
  if (title.type === "tv") {
    if (title.seasons) bits.push(`${title.seasons} season${title.seasons > 1 ? "s" : ""}`);
    if (title.status) bits.push(title.status === "ended" ? "Ended" : "Ongoing");
  } else if (title.runtime) {
    bits.push(`${title.runtime} min`);
  }
  if (title.rating) bits.push(`★ ${title.rating.toFixed(1)}`);
  return (
    <p className="meta">
      {bits.filter(Boolean).join(" · ")}
      {genres ? <span className="genres"> · {genres}</span> : null}
    </p>
  );
}

export function Providers({ title }: { title: Title }) {
  const { meta } = useApp();
  if (!title.providers.length || !meta) return null;
  const names = title.providers.map((p) => meta.providers[String(p)]?.name).filter(Boolean);
  if (!names.length) return null;
  return <p className="providers">Stream: {names.slice(0, 4).join(", ")}</p>;
}

export function TitleCard({ title, reason, badges }: { title: Title; reason?: string; badges?: string[] }) {
  const [open, setOpen] = useState(false);
  const inWatchlist = useStore((s) => Boolean(s.watchlist[title.key] && !s.watchlist[title.key].deleted));
  return (
    <article className="card">
      <button type="button" className="card-poster" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Poster title={title} />
      </button>
      <div className="card-body">
        <h3>
          {title.title} <TypeBadge title={title} />
          {badges?.map((b) => (
            <span key={b} className="badge">
              {b}
            </span>
          ))}
        </h3>
        <TitleMeta title={title} />
        {reason ? <p className="reason">{reason}</p> : null}
        <Providers title={title} />
        {open && title.overview ? <p className="overview">{title.overview}</p> : null}
        <div className="actions">
          <RatingControl title={title} />
          <button
            type="button"
            className={inWatchlist ? "chip on" : "chip"}
            aria-pressed={inWatchlist}
            onClick={() => toggleWatchlist(title.key, title)}
          >
            {inWatchlist ? "✓ Watchlist" : "+ Watchlist"}
          </button>
          <a className="link" href={tmdbUrl(title.key)} target="_blank" rel="noreferrer">
            TMDB ↗
          </a>
        </div>
      </div>
    </article>
  );
}
