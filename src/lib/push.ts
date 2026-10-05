"use client";

import { getSupabase } from "./supabase";
import { NOTIFY_URL } from "./notifications";

/**
 * Opt-in Web Push for "It's a match" (VAPID). Platform limits:
 * - iPhone/iPad: only for the app added to the Home Screen (iOS/iPadOS 16.4+).
 * - Android Chrome/Edge/Firefox and desktop browsers: works in the browser and when installed.
 * In-app notifications work everywhere regardless.
 */

export type PushAvailability = "ok" | "unsupported" | "ios-install" | "denied";

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  standalone: boolean;
  permission: NotificationPermission | "unsupported";
}

export function pushAvailability(env: PushEnv): PushAvailability {
  // iOS Safari only exposes PushManager to Home Screen web apps.
  if (env.isIos && !env.standalone) return "ios-install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  if (env.permission === "denied") return "denied";
  return "ok";
}

export function detectPushEnv(): PushEnv {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const w = typeof window !== "undefined" ? window : undefined;
  const ua = nav?.userAgent ?? "";
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && (nav?.maxTouchPoints ?? 0) > 1);
  const standalone =
    Boolean(w?.matchMedia?.("(display-mode: standalone)").matches) || (nav as { standalone?: boolean } | undefined)?.standalone === true;
  const hasNotification = Boolean(w && "Notification" in w);
  return {
    hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
    hasPushManager: Boolean(w && "PushManager" in w),
    hasNotification,
    isIos,
    standalone,
    permission: hasNotification ? Notification.permission : "unsupported",
  };
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let vapidKey: Promise<string | null> | null = null;

/** The VAPID public key from the notify-match function (null when push isn't configured). */
export function getVapidPublicKey(): Promise<string | null> {
  vapidKey ??= (async () => {
    if (!NOTIFY_URL) return null;
    try {
      const res = await fetch(NOTIFY_URL, { method: "GET" });
      if (!res.ok) return null;
      return ((await res.json()) as { publicKey?: string | null }).publicKey ?? null;
    } catch {
      return null;
    }
  })().then((k) => {
    if (!k) vapidKey = null; // retry later (e.g. it was offline)
    return k;
  });
  return vapidKey;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? navigator.serviceWorker.ready : null;
}

/** Is this device currently subscribed (and allowed)? */
export async function pushEnabled(): Promise<boolean> {
  if (pushAvailability(detectPushEnv()) !== "ok" || Notification.permission !== "granted") return false;
  const reg = await registration();
  return Boolean(await reg?.pushManager.getSubscription());
}

/** Ask permission, subscribe this device and store the subscription (own row via RLS). */
export async function enablePush(): Promise<string | null> {
  const avail = pushAvailability(detectPushEnv());
  if (avail === "ios-install") return "On iPhone, add Reel Picks to your Home Screen first (Share → Add to Home Screen), then enable notifications there.";
  if (avail === "unsupported") return "This browser doesn't support push notifications.";
  if (avail === "denied") return "Notifications are blocked for this site. Allow them in your browser settings.";
  const supabase = getSupabase();
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  if (!supabase || !session) return "Sign in first.";
  const key = await getVapidPublicKey();
  if (!key) return "Push notifications aren't set up on the server yet.";
  const reg = await registration();
  if (!reg) return "The app's service worker isn't active yet. Reload and try again.";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications weren't allowed.";
  // Always start from a fresh subscription, so an endpoint never belongs to two accounts.
  const old = await reg.pushManager.getSubscription();
  if (old) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", old.endpoint);
    await old.unsubscribe().catch(() => undefined);
  }
  try {
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
    const json = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").insert({
      user_id: session.user.id, endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "",
    });
    if (error) {
      await sub.unsubscribe().catch(() => undefined);
      return `Couldn't save the subscription (${error.message}).`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Couldn't subscribe to notifications.";
  }
}

/** Unsubscribe this device and delete its row (also used on sign-out). */
export async function disablePush(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const supabase = getSupabase();
  if (supabase && (await supabase.auth.getSession()).data.session) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  }
  await sub.unsubscribe().catch(() => undefined);
}
