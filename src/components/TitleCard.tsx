"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { posterUrl } from "@/lib/config";
import { tmdbUrl } from "@/lib/keys";
import { toggleWatchlist, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";
import { useApp } from "./AppProvider";
import { RatingControl } from "./RatingControl";

function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Generated stand-in poster when TMDB has no image (or it fails to load, e.g. offline). */
function PlaceholderPoster({ title }: { title: Title }) {
  const h = hue(title.key);
  return (
    <div
      className="poster placeholder"
      aria-hidden
      style={{ background: `linear-gradient(160deg, hsl(${h} 45% 32%), hsl(${(h + 40) % 360} 40% 14%))` }}
    >
      <span className="ph-title">{title.title}</span>
      <span className="ph-year">
        {title.year || ""}
        {title.type === "tv" ? " · TV" : ""}
      </span>
    </div>
  );
}

export function Poster({ title, size = "w342" }: { title: Title; size?: "w185" | "w342" }) {
  const url = posterUrl(title.poster, size);
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <PlaceholderPoster title={title} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="poster" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
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

export function TitleCard({
  title,
  reason,
  badges,
  dimWhenRated = false,
}: {
  title: Title;
  reason?: string;
  badges?: string[];
  /** Feed: keep a card in place after rating it, but fade it so the list doesn't jump. */
  dimWhenRated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const overviewRef = useRef<HTMLParagraphElement>(null);
  const rated = useStore((s) => Boolean(s.ratings[title.key] && !s.ratings[title.key].deleted));
  const inWatchlist = useStore((s) => Boolean(s.watchlist[title.key] && !s.watchlist[title.key].deleted));

  // Only offer "More" when the 2-line clamp actually hides text.
  useLayoutEffect(() => {
    const el = overviewRef.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [title.overview, open]);

  const expandable = overflows || open;
  const toggle = () => expandable && setOpen((o) => !o);
  // The whole card toggles, except its own controls (rating, watchlist, links).
  const onCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, label")) return;
    toggle();
  };

  const classes = ["card", expandable ? "expandable" : "", dimWhenRated && rated ? "rated" : ""].filter(Boolean).join(" ");
  return (
    <article className={classes} onClick={onCardClick}>
      <div className="card-poster">
        <Poster title={title} />
      </div>
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
        {title.overview ? (
          <>
            <p ref={overviewRef} className={open ? "overview" : "overview clamp"} id={`ov-${title.key}`}>
              {title.overview}
            </p>
            {expandable ? (
              <button type="button" className="more-toggle" aria-expanded={open} aria-controls={`ov-${title.key}`} onClick={toggle}>
                {open ? "Less ▴" : "More ▾"}
              </button>
            ) : null}
          </>
        ) : null}
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
          <Link className="chip like-this" href={`/similar/?key=${encodeURIComponent(title.key)}`}>
            More like this
          </Link>
          <a className="link" href={tmdbUrl(title.key)} target="_blank" rel="noreferrer">
            TMDB ↗
          </a>
        </div>
      </div>
    </article>
  );
}
