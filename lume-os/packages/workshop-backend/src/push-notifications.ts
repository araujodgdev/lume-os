// (Lume) Push notifications: the per-user device list lives in UserDurableObject; this module holds
// the delivery and the scheduled poll of gatekeepers that provide notifications.

import type { GatekeeperNotification, GatekeeperVendor } from "@gadgets/workshop-shared/gatekeeper";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";
import { createWorkshopLogger } from "./observability";
import type { UserDurableObject } from "./user.js";
import { sendWebPush, type PushSubscriptionData, type VapidKeys } from "./web-push.js";

const logger = createWorkshopLogger("workshop.push");

/** A device that enabled notifications. */
export type PushSubscriptionRecord = PushSubscriptionData & { createdAt: number };

/** At most this many devices per user; the oldest is dropped past it. */
export const MAX_DEVICES = 10;

/** The deployment's VAPID keys and contact, or null when push is not configured. */
export function vapidConfig(env: Cloudflare.Env): { keys: VapidKeys; subject: string } | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  // Push services want a contact: an https origin or a mailto. The public origin is both stable
  // and ours; local development has none.
  const origin = env.PUBLIC_BASE_URL?.startsWith("https://") ? new URL(env.PUBLIC_BASE_URL).origin : null;
  return {
    keys: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    subject: origin ?? "mailto:lume@localhost",
  };
}

/** What the service worker receives. */
export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/**
 * Sends `message` to each device, returning how many took it and which subscriptions expired.
 * Failures other than expiry are logged and skipped: one bad device must not block the rest.
 */
export async function deliver(
  env: Cloudflare.Env,
  devices: PushSubscriptionRecord[],
  message: PushMessage,
): Promise<{ delivered: number; expired: string[] }> {
  const vapid = vapidConfig(env);
  if (!vapid || devices.length === 0) return { delivered: 0, expired: [] };
  let delivered = 0;
  const expired: string[] = [];
  await Promise.all(devices.map(async (device) => {
    try {
      const result = await sendWebPush(device, message, vapid.keys, vapid.subject, {
        urgency: "high",
        ...(message.tag ? { topic: message.tag } : {}),
      });
      if (result.ok) delivered++;
      else if (result.expired) expired.push(device.endpoint);
      else logger.warn("push rejected", { event: "push.rejected", status: result.status });
    } catch (error) {
      logger.warn("push failed", { event: "push.failed", error });
    }
  }));
  return { delivered, expired };
}

/**
 * The scheduled poll: asks every vendor that provides notifications for pending ones, delivers
 * each to its users' devices, and acknowledges them. A user without devices simply gets nothing.
 */
export async function pollGatekeeperNotifications(
  env: Cloudflare.Env,
  users: DurableObjectNamespace<UserDurableObject>,
): Promise<void> {
  if (!vapidConfig(env)) return;
  for (const [vendorId, vendor] of buildGatekeeperVendorMap(env)) {
    try {
      const description = await vendor.describe();
      if (!description.providesNotifications) continue;
      const typed = vendor as unknown as Required<Pick<GatekeeperVendor, "takeNotifications" | "ackNotifications">>;
      const notifications: GatekeeperNotification[] = await typed.takeNotifications();
      if (notifications.length === 0) continue;
      for (const n of notifications) {
        const message: PushMessage = { title: n.title, body: n.body, ...(n.url ? { url: n.url } : {}), ...(n.tag ? { tag: n.tag } : {}) };
        await Promise.all([...new Set(n.usernames)].map((username) =>
          users.get(users.idFromName(username)).deliverNotification(message).catch((error: unknown) => {
            logger.warn("push delivery failed", { event: "push.deliver.failed", vendorId, error });
          })));
      }
      await typed.ackNotifications(notifications.map((n) => n.id));
    } catch (error) {
      logger.warn("notification poll failed", { event: "push.poll.failed", vendorId, error });
    }
  }
}
