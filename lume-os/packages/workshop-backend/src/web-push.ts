// (Lume) Web Push without dependencies: VAPID (RFC 8292) and message encryption (RFC 8291 with
// the aes128gcm content coding of RFC 8188), on WebCrypto.

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionData = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** The deployment's VAPID key pair, both base64url: the raw public point and the private scalar. */
export type VapidKeys = { publicKey: string; privateKey: string };

/** Record size written in the header. One record holds the whole message. */
const RECORD_SIZE = 4096;
/** Largest payload that fits one record: record size minus tag (16) and delimiter (1). */
export const MAX_PAYLOAD = RECORD_SIZE - 17;

const encoder = new TextEncoder();

export function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A P-256 private key from its raw scalar and uncompressed public point. */
async function importPrivateKey(d: Uint8Array, publicPoint: Uint8Array, usage: "ecdh" | "ecdsa"): Promise<CryptoKey> {
  if (publicPoint.length !== 65 || publicPoint[0] !== 4) throw new Error("Chave pública P-256 inválida.");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: base64UrlEncode(d),
    x: base64UrlEncode(publicPoint.slice(1, 33)),
    y: base64UrlEncode(publicPoint.slice(33, 65)),
    ext: true,
  };
  return usage === "ecdh"
    ? crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
    : crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** A fresh sender key pair, as raw bytes. */
async function ephemeralKeys(): Promise<{ publicPoint: Uint8Array; privateScalar: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicPoint = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicPoint, privateScalar: base64UrlDecode(jwk.d!) };
}

/**
 * Encrypts `payload` for a subscription (RFC 8291). `fixed` pins the sender key and salt, for
 * checking against the RFC's test vector; production always draws fresh ones.
 */
export async function encryptPayload(
  payload: Uint8Array,
  keys: PushSubscriptionData["keys"],
  fixed?: { senderPublic: Uint8Array; senderPrivate: Uint8Array; salt: Uint8Array },
): Promise<Uint8Array> {
  if (payload.length > MAX_PAYLOAD) throw new Error("Aviso grande demais para um push.");
  const uaPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  const sender = fixed
    ? { publicPoint: fixed.senderPublic, privateScalar: fixed.senderPrivate }
    : await ephemeralKeys();
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const senderKey = await importPrivateKey(sender.privateScalar, sender.publicPoint, "ecdh");
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The Workers types spell the peer key `$public`; the runtime takes the standard `public`.
  const ecdh = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, senderKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, sender.publicPoint);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record, so the padding delimiter is 0x02 ("last record") and no padding follows.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(payload, new Uint8Array([2]))),
  );
  const header = new Uint8Array(16 + 4 + 1 + sender.publicPoint.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicPoint.length;
  header.set(sender.publicPoint, 21);
  return concat(header, ciphertext);
}

/** The VAPID `Authorization` header for a push service. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const publicPoint = base64UrlDecode(vapid.publicKey);
  const key = await importPrivateKey(base64UrlDecode(vapid.privateKey), publicPoint, "ecdsa");
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)),
  );
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`;
}

/** What a push service answered. `expired` means the subscription is gone and should be dropped. */
export type PushResult = { ok: boolean; status: number; expired: boolean };

/** Sends one encrypted message to a subscription. */
export async function sendWebPush(
  subscription: PushSubscriptionData,
  message: unknown,
  vapid: VapidKeys,
  subject: string,
  options: { ttlSeconds?: number; urgency?: "normal" | "high"; topic?: string } = {},
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  const body = await encryptPayload(encoder.encode(JSON.stringify(message)), subscription.keys);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(subscription.endpoint, vapid, subject),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttlSeconds ?? 24 * 60 * 60),
    Urgency: options.urgency ?? "normal",
  };
  // Topics collapse pending messages; the push service accepts at most 32 base64url characters.
  if (options.topic) headers.Topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const response = await fetcher(subscription.endpoint, { method: "POST", headers, body });
  return { ok: response.ok, status: response.status, expired: response.status === 404 || response.status === 410 };
}

/** Checks a subscription from a browser before storing it. */
export function validatePushSubscription(input: unknown): PushSubscriptionData {
  const sub = input as PushSubscriptionData;
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys || typeof sub.keys !== "object") {
    throw new TypeError("Inscrição de push inválida.");
  }
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    throw new TypeError("Endereço de push inválido.");
  }
  if (url.protocol !== "https:" || sub.endpoint.length > 2000) throw new TypeError("Endereço de push inválido.");
  const { p256dh, auth } = sub.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") throw new TypeError("Chaves de push inválidas.");
  if (base64UrlDecode(p256dh).length !== 65 || base64UrlDecode(auth).length !== 16) {
    throw new TypeError("Chaves de push inválidas.");
  }
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

/** Generates a VAPID key pair (used by the deploy script and tests). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const publicPoint = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { publicKey: base64UrlEncode(publicPoint), privateKey: jwk.d! };
}
