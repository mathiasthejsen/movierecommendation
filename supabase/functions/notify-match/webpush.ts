// Minimal Web Push sender (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID), WebCrypto only,
// so the same code runs in the Supabase Edge runtime (Deno) and in vitest (Node 20+).
// No Deno globals here: index.ts passes in the keys and fetch.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, uncompressed P-256 point (65 bytes)
  auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url, 32-byte scalar "d"
  subject: string; // "mailto:..." or "https://..."
}

type Bytes = Uint8Array<ArrayBuffer>;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Bytes {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
  const key = await subtle().importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, key, length * 8);
  return new Uint8Array(bits);
}

function ecPublicJwk(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("expected an uncompressed P-256 public key");
  return { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), ext: true };
}

/** Derive the two content keys of RFC 8291 §3.4 (shared by encrypt and the test decrypt). */
export async function deriveContentKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
) {
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce };
}

export async function ecdh(privateKey: CryptoKey, publicRaw: Uint8Array): Promise<Bytes> {
  const pub = await subtle().importKey("jwk", ecPublicJwk(publicRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, privateKey, 256));
}

/** Encrypt one push message (single record, aes128gcm). Returns the full request body. */
export async function encryptPayload(
  plaintext: Uint8Array,
  sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">,
  opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Bytes> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const server =
    opts.serverKeys ?? ((await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await subtle().exportKey("raw", server.publicKey));
  const secret = await ecdh(server.privateKey, uaPublic);
  const { cek, nonce } = await deriveContentKeys(secret, authSecret, uaPublic, asPublic, salt);
  const key = await subtle().importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single (last) record: plaintext followed by the 0x02 delimiter, no padding.
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** VAPID JWT (ES256) for the push service origin. */
export async function vapidJwt(audience: string, vapid: VapidKeys, nowSeconds: number, ttlSeconds = 12 * 3600): Promise<string> {
  const pub = b64urlDecode(vapid.publicKey);
  const key = await subtle().importKey(
    "jwk",
    { ...ecPublicJwk(pub), d: vapid.privateKey },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: nowSeconds + ttlSeconds, sub: vapid.subject })));
  const input = `${header}.${claims}`;
  // WebCrypto returns the raw r||s signature, which is exactly the JWS ES256 format.
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

export interface PushResult {
  endpoint: string;
  status: number; // 0 = network error
  gone: boolean; // 404/410: the subscription is dead and should be deleted
}

/** Encrypt + POST one notification. Never throws. */
export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: unknown,
  vapid: VapidKeys,
  fetchFn: typeof fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<PushResult> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub);
    const jwt = await vapidJwt(new URL(sub.endpoint).origin, vapid, nowSeconds);
    const res = await fetchFn(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body,
    });
    return { endpoint: sub.endpoint, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { endpoint: sub.endpoint, status: 0, gone: false };
  }
}
