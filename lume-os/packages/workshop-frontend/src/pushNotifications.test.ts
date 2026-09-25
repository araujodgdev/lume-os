// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlToBytes, enablePush, pushSupport, type PushApi } from "./pushNotifications";

const KEY = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";

function api(key: string | null = KEY) {
  return {
    getPushPublicKey: vi.fn<PushApi["getPushPublicKey"]>(async () => key),
    registerPushSubscription: vi.fn<PushApi["registerPushSubscription"]>(async () => {}),
    removePushSubscription: vi.fn<PushApi["removePushSubscription"]>(async () => {}),
  } satisfies PushApi;
}

afterEach(() => vi.unstubAllGlobals());

describe("push neste dispositivo", () => {
  it("reconhece o iPhone fora da tela de início", () => {
    const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } as Navigator;
    const semPush = { matchMedia: () => ({ matches: false }) } as unknown as Window;
    expect(pushSupport(iphone, semPush)).toBe("ios-install");
    expect(pushSupport({ userAgent: "Firefox" } as Navigator, semPush)).toBe("unsupported");
    const chrome = { userAgent: "Chrome", serviceWorker: {} } as unknown as Navigator;
    expect(pushSupport(chrome, { PushManager: {}, Notification: {}, matchMedia: () => ({ matches: false }) } as unknown as Window)).toBe("ok");
  });

  it("decodifica a chave do servidor", () => {
    const bytes = base64UrlToBytes(KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });

  it("não pede permissão quando o servidor não tem chave", async () => {
    const requestPermission = vi.fn<() => Promise<string>>();
    vi.stubGlobal("Notification", { requestPermission });
    await expect(enablePush(api(null))).rejects.toThrow("não foram configurados");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("inscreve o dispositivo com a chave do servidor e o registra", async () => {
    const subscription = {
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint: "https://push.example.com/1", keys: { p256dh: KEY, auth: "BTBZMqHH6r4Tts7J_aSIgg" } }),
    };
    const subscribe = vi.fn<(options: unknown) => Promise<typeof subscription>>(async () => subscription);
    vi.stubGlobal("Notification", { requestPermission: vi.fn<() => Promise<string>>(async () => "granted") });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn<() => Promise<unknown>>(async () => ({ pushManager: { getSubscription: async () => null, subscribe } })),
        ready: Promise.resolve(),
      },
    });
    const server = api();
    await enablePush(server);
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(KEY) });
    expect(server.registerPushSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.example.com/1", keys: { p256dh: KEY, auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    });
  });

  it("explica quando o navegador nega a permissão", async () => {
    vi.stubGlobal("Notification", { requestPermission: vi.fn<() => Promise<string>>(async () => "denied") });
    await expect(enablePush(api())).rejects.toThrow("não deu permissão");
  });
});
