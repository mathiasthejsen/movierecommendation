"use client";

import { useEffect, useState } from "react";
import { detectPushEnv, disablePush, enablePush, getVapidPublicKey, pushAvailability, pushEnabled, type PushAvailability } from "@/lib/push";
import { useApp } from "./AppProvider";

/** Me → Notifications: in-app matches always; optional Web Push per device. Signed-in only. */
export function NotificationSettings() {
  const { session } = useApp();
  const [avail, setAvail] = useState<PushAvailability | null>(null);
  const [serverReady, setServerReady] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setAvail(pushAvailability(detectPushEnv()));
    void getVapidPublicKey().then((k) => !cancelled && setServerReady(Boolean(k)));
    void pushEnabled()
      .then((v) => !cancelled && setOn(v))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) return null;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setMessage(null);
    if (next) {
      const err = await enablePush();
      setOn(!err);
      setMessage(err ?? "Notifications are on for this device.");
    } else {
      await disablePush().catch(() => undefined);
      setOn(false);
      setMessage("Notifications are off for this device.");
    }
    setAvail(pushAvailability(detectPushEnv()));
    setBusy(false);
  };

  return (
    <section className="notice stack" aria-labelledby="notif-heading">
      <h2 id="notif-heading" style={{ margin: 0 }}>
        Notifications
      </h2>
      <p className="small">
        When someone in the family adds a title that&apos;s already on your watchlist, you get a 🎉 match under{" "}
        <strong>Watchlist → 🔔</strong>. That always works in the app.
      </p>
      {serverReady === false ? null : avail === "ios-install" ? (
        <p className="small muted">
          📱 On iPhone, phone notifications only work in the installed app (iOS 16.4 or later): tap Share →{" "}
          <em>Add to Home Screen</em>, open Reel Picks from your Home Screen, and turn them on here.
        </p>
      ) : avail === "unsupported" ? (
        <p className="small muted">This browser doesn&apos;t support phone notifications. In-app notifications still work.</p>
      ) : (
        <>
          <label className="feed-option">
            <input type="checkbox" checked={on} disabled={busy || avail === null || serverReady === null} onChange={(e) => void toggle(e.target.checked)} />
            <span>Enable notifications on this device</span>
          </label>
          {avail === "denied" ? (
            <p className="small muted">Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.</p>
          ) : (
            <p className="small muted">Android and desktop browsers work in the browser and when installed. You can turn this off any time.</p>
          )}
        </>
      )}
      {message ? (
        <p className="small" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
