"use client";

import { useApp } from "./AppProvider";

export function SampleBanner() {
  const { meta } = useApp();
  if (!meta?.sample) return null;
  return (
    <div className="banner" role="note">
      Demo catalogue ({meta.counts.titles ?? meta.counts.movies} titles). Posters and details are real, but similarity scores
      are synthetic. Run the data pipeline for real recommendations.
    </div>
  );
}

export function Attribution() {
  const { meta } = useApp();
  return (
    <footer className="attribution">
      <p>
        <a href="https://www.themoviedb.org/" target="_blank" rel="noreferrer">
          <strong>TMDB</strong>
        </a>{" "}
        — This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability by{" "}
        <a href="https://www.justwatch.com/" target="_blank" rel="noreferrer">
          JustWatch
        </a>
        .
      </p>
      <p>
        Film similarity derived from{" "}
        <a href="https://grouplens.org/datasets/movielens/" target="_blank" rel="noreferrer">
          MovieLens
        </a>{" "}
        (GroupLens, University of Minnesota; non-commercial use). Recommendation links mined from public Reddit threads
        via the official API. Curator picks from public Letterboxd RSS feeds and your own shares.
      </p>
      {meta?.counts.traktEdges ? (
        <p>
          Related-show data from{" "}
          <a href="https://trakt.tv/" target="_blank" rel="noreferrer">
            <strong>Trakt</strong>
          </a>
          .
        </p>
      ) : null}
      {meta ? (
        <p className="muted">
          Data {meta.sample ? "(sample) " : ""}updated {new Date(meta.generatedAt).toLocaleDateString()} · region {meta.region}
        </p>
      ) : null}
    </footer>
  );
}

/** Shown app-wide once a newer weekly data build has been deployed. */
export function NewDataBanner() {
  const { newDataAvailable } = useApp();
  if (!newDataAvailable) return null;
  return (
    <div className="banner new-data" role="status">
      New data available.{" "}
      <button type="button" className="chip" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
