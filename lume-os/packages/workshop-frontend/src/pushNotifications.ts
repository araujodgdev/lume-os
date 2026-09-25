// (Lume) Push notifications on this device: the service worker at /sw.js shows what the Workshop
// pushes. Kept apart from the page so the flow can be tested without a browser push service.

/** What this device can do about notifications. */
export type PushSupport =
  /** Push works here. */
  | "ok"
  /** iPhone or iPad Safari: push works only after "Adicionar à Tela de Início". */
  | "ios-install"
  /** No push in this browser. */
  | "unsupported";

export function pushSupport(nav: Navigator = navigator, win: Window = window): PushSupport {
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent);
  const standalone =
    (nav as Navigator & { standalone?: boolean }).standalone === true ||
    win.matchMedia?.("(display-mode: standalone)").matches === true;
  if ("serviceWorker" in nav && "PushManager" in win && "Notification" in win) return "ok";
  return ios && !standalone ? "ios-install" : "unsupported";
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The part of the authenticated API this flow uses. */
export type PushApi = {
  getPushPublicKey(): Promise<string | null>;
  registerPushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void>;
  removePushSubscription(endpoint: string): Promise<void>;
};

function asSubscriptionJson(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth } };
}

/** This device's current subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes this device and tells the Workshop. Throws a message for the page. */
export async function enablePush(api: PushApi): Promise<PushSubscription> {
  const key = await api.getPushPublicKey();
  if (!key) throw new Error("Os avisos ainda não foram configurados neste servidor.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("O navegador não deu permissão para avisos. Libere nas configurações do site e tente de novo.");
  }
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const expected = base64UrlToBytes(key);
  const current = subscription?.options.applicationServerKey;
  // A subscription made with another server key (after a key change) cannot receive our pushes.
  if (subscription && current && !sameBytes(new Uint8Array(current), expected)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expected });
  await api.registerPushSubscription(asSubscriptionJson(subscription));
  return subscription;
}

/** Re-sends the existing subscription, so the Workshop keeps it after pruning or a reinstall. */
export async function syncPush(api: PushApi, subscription: PushSubscription): Promise<void> {
  await api.registerPushSubscription(asSubscriptionJson(subscription));
}

export async function disablePush(api: PushApi, subscription: PushSubscription): Promise<void> {
  await api.removePushSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
