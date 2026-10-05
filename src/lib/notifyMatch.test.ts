import { describe, expect, it, vi } from "vitest";
import {
  handleNotify,
  matchPayload,
  matchRecipients,
  RATE_LIMIT,
  type NotificationInsert,
  type NotifyStore,
  type ProfileRow,
  type SubscriptionRow,
  type WatchRow,
} from "../../supabase/functions/notify-match/logic";
import { b64urlDecode, b64urlEncode, concat, deriveContentKeys, ecdh, encryptPayload, sendPush, vapidJwt } from "../../supabase/functions/notify-match/webpush";
import { mergeNotifications, unreadCount, type AppNotification } from "./notifications";
import { pushAvailability } from "./push";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const prof = (user_id: string, share = true, name = user_id.slice(0, 1).toUpperCase()): ProfileRow => ({
  user_id, display_name: name, share_watchlist: share,
});

describe("matchRecipients (server-side verification)", () => {
  const rows: WatchRow[] = [
    { user_id: A, media_key: "movie:603", title: "The Matrix" },
    { user_id: B, media_key: "movie:603" },
    { user_id: C, media_key: "movie:603" },
    { user_id: B, media_key: "tv:603" },
  ];

  it("notifies every other member who has it, once each", () => {
    expect(matchRecipients(A, "movie:603", [...rows, rows[1]], [prof(A), prof(B), prof(C)])).toEqual([B, C]);
  });

  it("skips recipients who don't share, and everyone when the actor doesn't share", () => {
    expect(matchRecipients(A, "movie:603", rows, [prof(A), prof(B, false), prof(C)])).toEqual([C]);
    expect(matchRecipients(A, "movie:603", rows, [prof(A, false), prof(B), prof(C)])).toEqual([]);
  });

  it("requires the title on the actor's own watchlist (the client isn't trusted)", () => {
    expect(matchRecipients(C, "tv:603", rows, [prof(B), prof(C)])).toEqual([]);
    expect(matchRecipients(A, "movie:999", rows, [])).toEqual([]);
  });

  it("keeps movie and TV keys apart and treats a missing profile as sharing", () => {
    const r: WatchRow[] = [
      { user_id: A, media_key: "tv:603" },
      { user_id: B, media_key: "tv:603" },
      { user_id: C, media_key: "movie:603" },
    ];
    expect(matchRecipients(A, "tv:603", r, [])).toEqual([B]);
    expect(matchRecipients(A, "bogus", r, [])).toEqual([]);
  });

  it("builds the deep link to Together", () => {
    const p = matchPayload("Kim", "Dark", "tv:70523", "/movierecommendation/");
    expect(p.body).toBe("🎉 Kim also wants to watch Dark!");
    expect(p.url).toBe("/movierecommendation/watchlist/?tab=together&highlight=tv%3A70523");
  });
});

/** In-memory NotifyStore with the same semantics as the SQL (unique key, fixed-window limit). */
function fakeStore(rows: WatchRow[], profiles: ProfileRow[], subs: SubscriptionRow[] = []) {
  const notifications: NotificationInsert[] = [];
  const usage = new Map<string, number>();
  const deleted: string[] = [];
  const touched: string[] = [];
  const store: NotifyStore = {
    async consume(actor, limit) {
      const n = (usage.get(actor) ?? 0) + 1;
      usage.set(actor, n);
      return n <= limit;
    },
    async watchRows(key) {
      return rows.filter((r) => r.media_key === key);
    },
    async profiles(ids) {
      return profiles.filter((p) => ids.includes(p.user_id));
    },
    async insertNotifications(batch) {
      const fresh: string[] = [];
      for (const n of batch) {
        const dup = notifications.some((x) => x.user_id === n.user_id && x.actor_id === n.actor_id && x.title_key === n.title_key && x.kind === n.kind);
        if (!dup) {
          notifications.push(n);
          fresh.push(n.user_id);
        }
      }
      return fresh;
    },
    async subscriptions(ids) {
      return subs.filter((s) => ids.includes(s.user_id));
    },
    async deleteSubscriptions(endpoints) {
      deleted.push(...endpoints);
    },
    async touchSubscriptions(endpoints) {
      touched.push(...endpoints);
    },
  };
  return { store, notifications, deleted, touched };
}

async function uaKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) };
}

async function vapidKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64urlEncode(pub), privateKey: jwk.d!, subject: "https://example.invalid/app/", verifyKey: kp.publicKey };
}

describe("handleNotify", () => {
  const rows: WatchRow[] = [
    { user_id: A, media_key: "movie:603", title: "The Matrix" },
    { user_id: B, media_key: "movie:603" },
  ];

  it("deduplicates: re-adding the same title doesn't notify again", async () => {
    const f = fakeStore(rows, [prof(A), prof(B)]);
    const fetchFn = vi.fn();
    const first = await handleNotify({ store: f.store, actorId: A, key: "movie:603", vapid: null, fetchFn, basePath: "/x" });
    const again = await handleNotify({ store: f.store, actorId: A, key: "movie:603", vapid: null, fetchFn, basePath: "/x" });
    expect(first.body.notified).toBe(1);
    expect(again.body.notified).toBe(0);
    expect(f.notifications).toHaveLength(1);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rate limits to 20 calls per actor per hour", async () => {
    const f = fakeStore(rows, [prof(A), prof(B)]);
    const call = () => handleNotify({ store: f.store, actorId: A, key: "movie:603", vapid: null, fetchFn: vi.fn(), basePath: "/x" });
    for (let i = 0; i < RATE_LIMIT; i++) expect((await call()).status).toBe(200);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
  });

  it("rejects malformed keys", async () => {
    const f = fakeStore(rows, []);
    expect((await handleNotify({ store: f.store, actorId: A, key: "movie:1;drop", vapid: null, fetchFn: vi.fn(), basePath: "/x" })).status).toBe(400);
  });

  it("pushes to the recipient's devices and deletes subscriptions that return 404/410", async () => {
    const vapid = await vapidKeys();
    const live = await uaKeys();
    const dead = await uaKeys();
    const subs: SubscriptionRow[] = [
      { user_id: B, endpoint: "https://push.example.invalid/live", p256dh: live.p256dh, auth: live.auth },
      { user_id: B, endpoint: "https://push.example.invalid/gone", p256dh: dead.p256dh, auth: dead.auth },
      { user_id: A, endpoint: "https://push.example.invalid/actor", p256dh: live.p256dh, auth: live.auth },
    ];
    const f = fakeStore(rows, [prof(A, true, "Kim"), prof(B)], subs);
    const fetchFn = vi.fn(async (url: string | URL | Request) => new Response(null, { status: String(url).endsWith("/gone") ? 410 : 201 }));
    const res = await handleNotify({ store: f.store, actorId: A, key: "movie:603", vapid, fetchFn: fetchFn as unknown as typeof fetch, basePath: "/x" });
    expect(res.body).toEqual({ notified: 1, pushed: 1, removed: 1 });
    expect(fetchFn.mock.calls.map((c) => String(c[0])).sort()).toEqual(["https://push.example.invalid/gone", "https://push.example.invalid/live"]);
    expect(f.deleted).toEqual(["https://push.example.invalid/gone"]);
    expect(f.touched).toEqual(["https://push.example.invalid/live"]);
  });
});

describe("web push encryption (RFC 8291) and VAPID (RFC 8292)", () => {
  it("round-trips: the browser can decrypt what we send", async () => {
    const ua = await uaKeys();
    const body = await encryptPayload(new TextEncoder().encode('{"title":"hi"}'), ua);
    // Parse the aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(65) | ciphertext.
    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    expect(body[20]).toBe(65);
    const asPublic = body.slice(21, 86);
    const secret = await ecdh(ua.kp.privateKey, asPublic);
    const uaPublic = b64urlDecode(ua.p256dh);
    const { cek, nonce } = await deriveContentKeys(secret, b64urlDecode(ua.auth), uaPublic, asPublic, salt);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
    expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe('{"title":"hi"}');
  });

  it("signs a verifiable ES256 VAPID JWT for the push service origin", async () => {
    const v = await vapidKeys();
    const jwt = await vapidJwt("https://push.example.invalid", v, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c)))).toEqual({
      aud: "https://push.example.invalid", exp: 1_700_000_000 + 12 * 3600, sub: "https://example.invalid/app/",
    });
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v.verifyKey, b64urlDecode(s), concat(new TextEncoder().encode(`${h}.${c}`)));
    expect(ok).toBe(true);
  });

  it("sendPush reports 410 as gone and never throws on network errors", async () => {
    const v = await vapidKeys();
    const ua = await uaKeys();
    const sub = { endpoint: "https://push.example.invalid/x", p256dh: ua.p256dh, auth: ua.auth };
    const gone = await sendPush(sub, { a: 1 }, v, (async () => new Response(null, { status: 410 })) as unknown as typeof fetch);
    expect(gone).toMatchObject({ status: 410, gone: true });
    const down = await sendPush(sub, { a: 1 }, v, (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    expect(down).toMatchObject({ status: 0, gone: false });
  });
});

describe("in-app notifications (client)", () => {
  const n = (id: string, createdAt: string, readAt: string | null = null, userId = B): AppNotification => ({
    id, userId, actorId: A, key: "movie:603", kind: "match", createdAt, readAt,
  });

  it("badge counts only my unread notifications", () => {
    const items = [n("1", "2025-01-01"), n("2", "2025-01-02", "2025-01-03"), n("3", "2025-01-04"), n("4", "2025-01-05", null, C)];
    expect(unreadCount(items, B)).toBe(2);
    expect(unreadCount([], B)).toBe(0);
  });

  it("merges realtime inserts by id, newest first, keeping local read marks", () => {
    const merged = mergeNotifications([n("1", "2025-01-01", "2025-01-02")], [n("1", "2025-01-01"), n("2", "2025-01-03")]);
    expect(merged.map((x) => x.id)).toEqual(["2", "1"]);
    expect(merged[1].readAt).toBe("2025-01-02");
  });
});

describe("push availability", () => {
  const base = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIos: false, standalone: false, permission: "default" as const };
  it("explains platform limits", () => {
    expect(pushAvailability(base)).toBe("ok");
    expect(pushAvailability({ ...base, isIos: true })).toBe("ios-install");
    expect(pushAvailability({ ...base, isIos: true, standalone: true })).toBe("ok");
    expect(pushAvailability({ ...base, hasPushManager: false })).toBe("unsupported");
    expect(pushAvailability({ ...base, permission: "denied" })).toBe("denied");
  });
});
