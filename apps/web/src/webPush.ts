// Local metadata contains no credentials. Server confirmation is kept only in memory.
export const WEB_PUSH_STORAGE_PREFIX = "t3:web-push:";
const confirmed = new Set<string>();
const listeners = new Set<() => void>();
export function isWebPushConfirmed(environmentId: string) {
  return confirmed.has(environmentId);
}
export function subscribeWebPush(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setWebPushConfirmed(environmentId: string, enabled: boolean) {
  if (enabled === confirmed.has(environmentId)) return;
  if (enabled) confirmed.add(environmentId);
  else confirmed.delete(environmentId);
  for (const listener of listeners) listener();
}
export function webPushUnsupportedReason() {
  if (window.desktopBridge)
    return "Background web push is available in a supported installed web app, not Electron. Desktop notifications remain available.";
  if (!window.isSecureContext || !window.location.protocol.startsWith("https"))
    return "Background web push requires HTTPS.";
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window))
    return "This browser does not support background web push. Try installing T3 Code in Chrome on Android.";
  return null;
}
// Invoke synchronously in the user's gesture, before locks or RPC. Always let the browser
// handle the request; a reported denial must not prevent us from asking on the user's behalf.
export function requestWebPushPermission() {
  return Notification.requestPermission();
}
export function webPushScope(environmentId: string) {
  return `/web-push/${encodeURIComponent(environmentId)}/`;
}
export function webPushDeviceId(environmentId: string) {
  const key = `${WEB_PUSH_STORAGE_PREFIX}${environmentId}:device`;
  const stored = localStorage.getItem(key);
  if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- Browser-local device identity; no Effect runtime exists at this synchronous storage boundary.
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}
function markEnabled(environmentId: string, enabled: boolean) {
  localStorage.setItem(`${WEB_PUSH_STORAGE_PREFIX}${environmentId}:enabled`, String(enabled));
  setWebPushConfirmed(environmentId, enabled);
}
export function decodeApplicationServerKey(value: string) {
  const decoded = atob(
    value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "="),
  );
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export interface WebPushRpc {
  getConfig(): Promise<{ publicKey: string }>;
  getDevice(deviceId: string): Promise<{ enabled: boolean }>;
  register(input: {
    deviceId: string;
    origin: string;
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  }): Promise<{ enabled: boolean }>;
  unregister(deviceId: string): Promise<void>;
  test(deviceId: string): Promise<void>;
}
// The caller holds the per-environment browser lock across local and server changes.
export function createWebPushLifecycle(environmentId: string, rpc: WebPushRpc) {
  const registration = () =>
    navigator.serviceWorker
      .getRegistration(new URL(webPushScope(environmentId), window.location.origin).href)
      .then((value) =>
        value?.scope === new URL(webPushScope(environmentId), window.location.origin).href
          ? value
          : undefined,
      );
  return {
    async reconcile() {
      setWebPushConfirmed(environmentId, false);
      const local = await registration();
      const subscription = await local?.pushManager.getSubscription();
      const server = await rpc.getDevice(webPushDeviceId(environmentId));
      const enabled = Boolean(
        subscription && server.enabled && Notification.permission === "granted",
      );
      // Re-pair binds this existing device/subscription to the newly authenticated session.
      if (
        subscription &&
        Notification.permission === "granted" &&
        (enabled ||
          localStorage.getItem(`${WEB_PUSH_STORAGE_PREFIX}${environmentId}:enabled`) === "true")
      ) {
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
          throw new Error(
            "The browser returned an incomplete push subscription. Disable and enable push again.",
          );
        const repaired = await rpc.register({
          deviceId: webPushDeviceId(environmentId),
          origin: window.location.origin,
          subscription: {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          },
        });
        markEnabled(environmentId, repaired.enabled);
        return repaired.enabled;
      }
      markEnabled(environmentId, enabled);
      return enabled;
    },
    async enable(permission: Promise<NotificationPermission>) {
      if ((await permission) !== "granted")
        throw new Error(
          "The browser did not allow notifications. If no permission prompt appeared, open T3 Code in the full browser (not private/incognito mode) and check browser notification settings.",
        );
      const config = await rpc.getConfig();
      const local = await navigator.serviceWorker.register("/web-push-service-worker.js", {
        scope: webPushScope(environmentId),
      });
      // register() may resolve before the worker is active; ready is root-scope only.
      if (!local.active)
        await new Promise<void>((resolve, reject) => {
          const worker = local.installing ?? local.waiting;
          if (!worker) {
            reject(new Error("Push worker could not start. Reload and try again."));
            return;
          }
          const changed = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", changed);
              if (worker.state === "activated") resolve();
              else reject(new Error("Push worker installation failed. Reload and try again."));
            }
          };
          worker.addEventListener("statechange", changed);
          changed();
        });
      const existing = await local.pushManager.getSubscription();
      const subscription =
        existing ??
        (await local.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeApplicationServerKey(config.publicKey),
        }));
      try {
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
          throw new Error("The browser returned an incomplete push subscription.");
        const result = await rpc.register({
          deviceId: webPushDeviceId(environmentId),
          origin: window.location.origin,
          subscription: {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          },
        });
        if (!result.enabled) throw new Error("The server did not enable push. Try again.");
        markEnabled(environmentId, true);
      } catch (error) {
        setWebPushConfirmed(environmentId, false);
        // Never destroy a subscription another session had already established.
        if (!existing) await subscription.unsubscribe().catch(() => false);
        throw error;
      }
    },
    async disable() {
      await rpc.unregister(webPushDeviceId(environmentId));
      markEnabled(environmentId, false);
      const local = await registration();
      const subscription = await local?.pushManager.getSubscription();
      if (subscription && !(await subscription.unsubscribe()))
        throw new Error(
          "Server push is disabled, but browser cleanup failed. Press Disable again to retry.",
        );
    },
    async test() {
      await rpc.test(webPushDeviceId(environmentId));
    },
  };
}
export async function withWebPushLock<A>(
  environmentId: string,
  action: () => Promise<A>,
): Promise<A> {
  if (navigator.locks) return navigator.locks.request(`t3:web-push:${environmentId}`, action);
  return action();
}
