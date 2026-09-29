"use client";

import { useEffect, useState } from "react";
import { saveProfile, useFamily } from "@/lib/family";
import { defaultDisplayName } from "@/lib/together";
import { useApp } from "./AppProvider";

/** Me page: the name family members see, and whether they can see my watchlist. */
export function ProfileSettings() {
  const { session } = useApp();
  const meId = session?.user.id;
  const profile = useFamily((s) => (s.meId === meId ? s.profiles.find((p) => p.userId === meId) : undefined));
  const fallback = defaultDisplayName(session?.user.email);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(profile?.displayName ?? fallback), [profile?.displayName, fallback]);

  if (!session) return null;
  const sharing = profile?.shareWatchlist ?? true;

  const save = async (patch: { displayName?: string; shareWatchlist?: boolean }) => {
    setBusy(true);
    setStatus(null);
    const err = await saveProfile(patch);
    setBusy(false);
    setStatus(err ? `Couldn't save: ${err}` : "Saved.");
  };

  return (
    <section className="notice stack" aria-labelledby="profile-heading">
      <h2 id="profile-heading" style={{ margin: 0 }}>
        Family
      </h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ displayName: name });
        }}
      >
        <label htmlFor="display-name">Your name</label>
        <div className="row">
          <input
            id="display-name"
            type="text"
            maxLength={40}
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn" type="submit" disabled={busy || !name.trim() || name.trim() === profile?.displayName}>
            Save
          </button>
        </div>
        <span className="small muted">This is what your family sees on shared watchlists. Emails are never shown.</span>
      </form>
      <label className="row">
        <input
          type="checkbox"
          checked={sharing}
          disabled={busy}
          onChange={(e) => void save({ shareWatchlist: e.target.checked })}
        />{" "}
        Share my watchlist with family
      </label>
      <span className="small muted">
        {sharing
          ? "Family members can see your watchlist and what you have in common. Your ratings are always private."
          : "Your watchlist is private: nobody else can see it, and “Together” won't include you. Your ratings are always private."}
      </span>
      {status ? (
        <p className="small" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
