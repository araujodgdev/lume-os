import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPayload,
  generateVapidKeys,
  sendWebPush,
  validatePushSubscription,
  vapidAuthorization,
} from "../src/web-push.js";

// RFC 8291, Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Decrypts a message as the browser would, to check messages with a random key and salt. */
async function decrypt(body: Uint8Array, uaPublic: Uint8Array, uaPrivate: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const senderPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const uaKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: base64UrlEncode(uaPrivate),
    x: base64UrlEncode(uaPublic.slice(1, 33)), y: base64UrlEncode(uaPublic.slice(33)),
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, uaKey, 256));
  const enc = new TextEncoder();
  const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: s, info },
    await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hkdf(auth, secret, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...senderPublic]), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("web push", () => {
  it("encrypts the RFC 8291 test vector byte for byte", async () => {
    const body = await encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { senderPublic: base64UrlDecode(RFC.asPublic), senderPrivate: base64UrlDecode(RFC.asPrivate), salt: base64UrlDecode(RFC.salt) },
    );
    expect(base64UrlEncode(body)).toBe(RFC.body);
  });

  it("encrypts with a fresh key and salt that the browser can decrypt", async () => {
    const body = await encryptPayload(new TextEncoder().encode('{"title":"Prazo"}'), { p256dh: RFC.uaPublic, auth: RFC.auth });
    expect(base64UrlEncode(body.slice(0, 16))).not.toBe(RFC.salt);
    expect(await decrypt(body, base64UrlDecode(RFC.uaPublic), base64UrlDecode(RFC.uaPrivate), base64UrlDecode(RFC.auth)))
      .toBe('{"title":"Prazo"}');
  });

  it("signs a VAPID token the push service can verify", async () => {
    const vapid = await generateVapidKeys();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, "mailto:ti@escritorio.com.br", 1_000_000_000_000);
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(vapid.publicKey);
    const [h, c, s] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(c)))).toEqual({
      aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 43_200, sub: "mailto:ti@escritorio.com.br",
    });
    const publicKey = await crypto.subtle.importKey("raw", base64UrlDecode(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, base64UrlDecode(s), new TextEncoder().encode(`${h}.${c}`)))
      .toBe(true);
  });

  it("posts the message and reports expired subscriptions", async () => {
    const vapid = await generateVapidKeys();
    const requests: Request[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response(null, { status: requests.length === 1 ? 201 : 410 });
    }) as unknown as typeof fetch;
    const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };
    expect(await sendWebPush(sub, { title: "Prazo" }, vapid, "mailto:a@b.c", { topic: "agenda/resumo" }, fetcher))
      .toEqual({ ok: true, status: 201, expired: false });
    expect(requests[0].headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(requests[0].headers.get("Topic")).toBe("agendaresumo");
    expect(await decrypt(new Uint8Array(await requests[0].arrayBuffer()), base64UrlDecode(RFC.uaPublic), base64UrlDecode(RFC.uaPrivate), base64UrlDecode(RFC.auth)))
      .toBe('{"title":"Prazo"}');
    expect(await sendWebPush(sub, { title: "x" }, vapid, "mailto:a@b.c", {}, fetcher)).toMatchObject({ expired: true });
  });

  it("validates subscriptions from the browser", () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    expect(validatePushSubscription({ endpoint: "https://push.example.com/x", keys, extra: 1 }))
      .toEqual({ endpoint: "https://push.example.com/x", keys });
    expect(() => validatePushSubscription({ endpoint: "http://push.example.com/x", keys })).toThrow("Endereço");
    expect(() => validatePushSubscription({ endpoint: "https://push.example.com/x", keys: { ...keys, auth: "AAAA" } })).toThrow("Chaves");
  });
});
