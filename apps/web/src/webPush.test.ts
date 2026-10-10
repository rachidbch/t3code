import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createWebPushLifecycle,
  isWebPushConfirmed,
  setWebPushConfirmed,
  webPushScope,
} from "./webPush";

const environmentId = "environment";
const deviceId = "11111111-1111-4111-8111-111111111111";
function fixture(existing = false) {
  const storage = new Map<string, string>();
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const subscription = {
    unsubscribe,
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: { p256dh: "public", auth: "secret" },
    }),
  };
  const subscribe = vi.fn().mockResolvedValue(subscription);
  const registration = {
    active: {},
    scope: `https://app.example${webPushScope(environmentId)}`,
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existing ? subscription : null),
      subscribe,
    },
  };
  const workerRegister = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal("window", { location: { origin: "https://app.example" } });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: workerRegister,
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
  });
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("crypto", { randomUUID: () => deviceId });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const rpc = {
    getConfig: vi.fn().mockResolvedValue({ publicKey: "AQID" }),
    getDevice: vi.fn().mockResolvedValue({ enabled: true }),
    register: vi.fn().mockResolvedValue({ enabled: true }),
    unregister: vi.fn().mockResolvedValue(undefined),
    test: vi.fn().mockResolvedValue(undefined),
  };
  return {
    lifecycle: createWebPushLifecycle(environmentId, rpc),
    rpc,
    registration,
    subscribe,
    unsubscribe,
    storage,
    workerRegister,
  };
}
afterEach(() => {
  setWebPushConfirmed(environmentId, false);
  vi.unstubAllGlobals();
});

describe("browser push registration lifecycle", () => {
  it("requires permission before creating a subscription or sending RPCs", async () => {
    const f = fixture();
    await expect(f.lifecycle.enable(Promise.resolve("denied"))).rejects.toThrow("blocked");
    expect(f.workerRegister).not.toHaveBeenCalled();
    expect(f.rpc.getConfig).not.toHaveBeenCalled();
  });

  it("subscribes under the destination environment scope and confirms only server acceptance", async () => {
    const f = fixture();
    await f.lifecycle.enable(Promise.resolve("granted"));
    expect(f.workerRegister).toHaveBeenCalledWith("/web-push-service-worker.js", {
      scope: "/web-push/environment/",
    });
    expect(f.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
    expect(f.rpc.register).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId, origin: "https://app.example" }),
    );
    expect(isWebPushConfirmed(environmentId)).toBe(true);
  });

  it("rolls back a new browser subscription if registration fails", async () => {
    const f = fixture();
    f.rpc.register.mockRejectedValue(new Error("offline"));
    await expect(f.lifecycle.enable(Promise.resolve("granted"))).rejects.toThrow("offline");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(isWebPushConfirmed(environmentId)).toBe(false);
  });

  it("does not destroy an existing subscription when registration fails", async () => {
    const f = fixture(true);
    f.rpc.register.mockRejectedValue(new Error("ownership"));
    await expect(f.lifecycle.enable(Promise.resolve("granted"))).rejects.toThrow("ownership");
    expect(f.unsubscribe).not.toHaveBeenCalled();
  });

  it("keeps browser delivery intact if server unregister fails", async () => {
    const f = fixture(true);
    setWebPushConfirmed(environmentId, true);
    f.rpc.unregister.mockRejectedValue(new Error("offline"));
    await expect(f.lifecycle.disable()).rejects.toThrow("offline");
    expect(f.unsubscribe).not.toHaveBeenCalled();
    expect(isWebPushConfirmed(environmentId)).toBe(true);
  });

  it("disables on the server first and allows failed browser cleanup to be retried", async () => {
    const f = fixture(true);
    setWebPushConfirmed(environmentId, true);
    f.unsubscribe.mockResolvedValueOnce(false);
    await expect(f.lifecycle.disable()).rejects.toThrow("cleanup failed");
    expect(isWebPushConfirmed(environmentId)).toBe(false);
    await f.lifecycle.disable();
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("repairs an opted-in subscription after pairing without requesting browser permission", async () => {
    const f = fixture(true);
    f.storage.set("t3:web-push:environment:enabled", "true");
    f.rpc.getDevice.mockResolvedValue({ enabled: false });
    expect(await f.lifecycle.reconcile()).toBe(true);
    expect(f.rpc.register).toHaveBeenCalledOnce();
    expect(f.workerRegister).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
  });

  it("does not automatically enroll a device without previous opt-in", async () => {
    const f = fixture(true);
    f.rpc.getDevice.mockResolvedValue({ enabled: false });
    expect(await f.lifecycle.reconcile()).toBe(false);
    expect(f.rpc.register).not.toHaveBeenCalled();
  });
});
