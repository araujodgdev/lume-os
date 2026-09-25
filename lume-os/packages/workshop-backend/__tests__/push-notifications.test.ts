import { describe, expect, it, vi } from "vitest";
import { pollGatekeeperNotifications } from "../src/push-notifications.js";
import { generateVapidKeys } from "../src/web-push.js";

function fakeUsers() {
  const delivered: { username: string; message: unknown }[] = [];
  const users = {
    idFromName: (name: string) => name,
    get: (username: string) => ({
      deliverNotification: async (message: unknown) => {
        delivered.push({ username, message });
        return 1;
      },
    }),
  };
  return { users: users as never, delivered };
}

describe("pollGatekeeperNotifications", () => {
  it("delivers each vendor notification to its users once and acknowledges it", async () => {
    const vapid = await generateVapidKeys();
    const ack = vi.fn(async () => {});
    const env = {
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      GATEKEEPER_AGENDA: {
        describe: async () => ({ providesNotifications: true }),
        takeNotifications: async () => [
          { id: "resumo:ana", usernames: ["ana", "ana"], title: "Agenda", body: "Hoje: Contestação", url: "/gatekeepers/agenda", tag: "agenda-resumo" },
          { id: "lembrete:1", usernames: ["ana", "bruno"], title: "Audiência às 14:30", body: "Sala 3" },
        ],
        ackNotifications: ack,
      },
      // A vendor without notifications is never asked for them.
      GATEKEEPER_CASOS: {
        describe: async () => ({}),
        takeNotifications: async () => { throw new Error("should not be called"); },
      },
    } as unknown as Cloudflare.Env;
    const { users, delivered } = fakeUsers();

    await pollGatekeeperNotifications(env, users);

    expect(delivered).toEqual([
      { username: "ana", message: { title: "Agenda", body: "Hoje: Contestação", url: "/gatekeepers/agenda", tag: "agenda-resumo" } },
      { username: "ana", message: { title: "Audiência às 14:30", body: "Sala 3" } },
      { username: "bruno", message: { title: "Audiência às 14:30", body: "Sala 3" } },
    ]);
    expect(ack).toHaveBeenCalledWith(["resumo:ana", "lembrete:1"]);
  });

  it("starts the requested conversation and points the notification at it", async () => {
    const vapid = await generateVapidKeys();
    const start = vi.fn(async (username: string) => (username === "ana" ? "/workspace/abc" : null));
    const env = {
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      GATEKEEPER_AGENDA: {
        describe: async () => ({ providesNotifications: true }),
        takeNotifications: async () => [{
          id: "resumo", usernames: ["ana", "ghost"], title: "Agenda", body: "Hoje: 1", url: "/gatekeepers/agenda",
          conversation: { title: "Prazos de 10/03/2026", prompt: "Resuma" },
        }],
        ackNotifications: async () => {},
      },
    } as unknown as Cloudflare.Env;
    const { users, delivered } = fakeUsers();

    await pollGatekeeperNotifications(env, users, { start });

    expect(start).toHaveBeenCalledWith("ana", { title: "Prazos de 10/03/2026", prompt: "Resuma" });
    // A user the Workshop does not know gets no conversation; the notification keeps its own link.
    expect(delivered.map((d) => [d.username, (d.message as { url: string }).url])).toEqual([
      ["ana", "/workspace/abc"],
      ["ghost", "/gatekeepers/agenda"],
    ]);
  });

  it("does nothing without VAPID keys", async () => {
    const take = vi.fn();
    const env = { GATEKEEPER_AGENDA: { describe: async () => ({ providesNotifications: true }), takeNotifications: take } } as unknown as Cloudflare.Env;
    await pollGatekeeperNotifications(env, fakeUsers().users);
    expect(take).not.toHaveBeenCalled();
  });
});
