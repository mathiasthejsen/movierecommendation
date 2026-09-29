"use client";

import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { DataUpdatePanel } from "@/components/DataUpdatePanel";
import { ProfileSettings } from "@/components/ProfileSettings";
import { Poster, TypeBadge } from "@/components/TitleCard";
import { RatingControl } from "@/components/RatingControl";
import { BASE_PATH, supabaseConfigured } from "@/lib/config";
import { activeRatings, syncNow, updateSettings, useStore } from "@/lib/store";
import { getSupabase, isNotInvitedError } from "@/lib/supabase";

const PRIVATE_MSG = "This app is private — ask the owner for an invite.";

function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return;
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Sign-ups are disabled: only invited family members get a link.
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}${BASE_PATH}/account/` },
    });
    setBusy(false);
    if (error) setMessage(isNotInvitedError(error) ? PRIVATE_MSG : `Couldn't send the link: ${error.message}`);
    else setSent(true);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    const supabase = getSupabase();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) setMessage(isNotInvitedError(error) ? PRIVATE_MSG : "That code didn't work — try the link or request a new one.");
  };

  return (
    <div className="notice stack">
      <form className="stack" onSubmit={send}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn" type="submit" disabled={busy || !email}>
          Send login link
        </button>
      </form>
      {sent ? (
        <form className="stack" onSubmit={verify}>
          <p className="small">
            Check your email and tap the link. If the email also shows a login code (it does once custom email is set up),
            you can type it here instead, which is handy in the installed iPhone app:
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="12345678"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn secondary" type="submit" disabled={busy || code.length < 6}>
            Use code
          </button>
        </form>
      ) : null}
      {message ? <p className={message === PRIVATE_MSG ? "" : "error"}>{message}</p> : null}
    </div>
  );
}

export default function AccountPage() {
  const { ready, session, meta, getTitle } = useApp();
  const ratings = useStore(activeRatings);
  const style = useStore((s) => s.settings.ratingStyle);
  const lastSync = useStore((s) => s.lastSync);
  const syncError = useStore((s) => s.syncError);

  return (
    <>
      <h1>Me</h1>
      {!supabaseConfigured ? (
        <p className="notice small">
          Sync isn&apos;t configured, so ratings stay on this device. Add the Supabase URL and anon key at build time to sync
          across devices (see README).
        </p>
      ) : session ? (
        <div className="notice stack">
          <p>
            Signed in as <strong>{session.user.email}</strong>. You stay signed in on this device.
          </p>
          <p className="small muted">
            {syncError ? <span className="error">Sync error: {syncError}</span> : lastSync ? `Synced ${new Date(lastSync).toLocaleString()}` : "Not synced yet"}
          </p>
          <div className="row">
            <button type="button" className="btn secondary" onClick={() => void syncNow()}>
              Sync now
            </button>
            <button type="button" className="btn secondary" onClick={() => void getSupabase()?.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <Login />
      )}

      {/* Signed-in only: display name + watchlist sharing. */}
      <ProfileSettings />

      {/* Renders nothing unless signed in and the trigger-pipeline function is configured. */}
      <DataUpdatePanel />

      <h2>Rating style</h2>
      <div className="segmented" role="radiogroup" aria-label="Rating style">
        <button type="button" role="radio" aria-checked={style === "thumb"} className={style === "thumb" ? "on" : ""} onClick={() => updateSettings({ ratingStyle: "thumb" })}>
          👍 👎
        </button>
        <button type="button" role="radio" aria-checked={style === "star"} className={style === "star" ? "on" : ""} onClick={() => updateSettings({ ratingStyle: "star" })}>
          ★ 1-5
        </button>
      </div>

      <h2>Install on your phone</h2>
      <p className="small">
        <strong>Android (Chrome):</strong> menu ⋮ → <em>Install app</em>. Once installed, “Reel Picks” appears in the Share
        sheet for Instagram/TikTok posts.
        <br />
        <strong>iPhone (Safari):</strong> Share → <em>Add to Home Screen</em>. iOS doesn&apos;t support share targets for web
        apps — use Picks → Add pick instead.
      </p>

      <h2>My ratings ({ratings.length})</h2>
      {ready ? (
        <div className="stack">
          {[...ratings]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map((r) => {
              const t = getTitle(r.key);
              if (!t) return null;
              return (
                <div className="match" key={r.key}>
                  <Poster title={t} size="w185" />
                  <div className="grow">
                    <strong>{t.title}</strong> <TypeBadge title={t} /> <span className="muted small">{t.year || ""}</span>
                  </div>
                  <RatingControl title={t} />
                </div>
              );
            })}
        </div>
      ) : null}

      {meta ? (
        <p className="muted small">
          Catalogue: {meta.counts.movies ?? 0} films, {meta.counts.tv ?? 0} series · {meta.counts.curatorPicks ?? 0} curator
          picks{meta.sample ? " · sample data" : ""}
        </p>
      ) : null}
    </>
  );
}
