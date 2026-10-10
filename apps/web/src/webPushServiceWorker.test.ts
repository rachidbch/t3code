// @effect-diagnostics nodeBuiltinImport:off -- Executes the actual browser worker script from disk in an isolated VM test fixture.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const script = NodeFS.readFileSync(
  new URL("../public/web-push-service-worker.js", import.meta.url),
  "utf8",
);
function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const origin = "https://app.example";
  NodeVM.runInContext(
    script,
    NodeVM.createContext({
      URL,
      self: {
        location: { origin },
        registration: { scope: `${origin}/web-push/environment/`, showNotification },
        clients: { openWindow, matchAll },
        addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
      },
    }),
  );
  const dispatch = async (type: string, value: Record<string, unknown>) => {
    const tasks: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...value, waitUntil: (task: Promise<unknown>) => tasks.push(task) });
    await Promise.all(tasks);
  };
  return { dispatch, showNotification, openWindow, matchAll };
}
const payload = {
  version: 1,
  environmentId: "environment",
  threadId: "thread:one",
  kind: "completion",
  title: "T3 Code",
  body: "Agent finished",
  tag: "run-one",
};
describe("notification-only push worker", () => {
  it("presents a system notification with thread destination while no page runs", async () => {
    const w = worker();
    await w.dispatch("push", { data: { json: () => payload } });
    expect(w.showNotification).toHaveBeenCalledWith(
      "T3 Code",
      expect.objectContaining({
        body: "Agent finished",
        tag: "run-one",
        data: { version: 1, environmentId: "environment", threadId: "thread:one" },
      }),
    );
  });
  it("rejects cross-environment and malformed pushes", async () => {
    const w = worker();
    for (const input of [
      { ...payload, environmentId: "other" },
      { ...payload, version: 2 },
      { ...payload, threadId: "" },
    ])
      await w.dispatch("push", { data: { json: () => input } });
    expect(w.showNotification).not.toHaveBeenCalled();
  });
  it("opens the actual encoded web thread route in a cold client", async () => {
    const w = worker();
    const close = vi.fn();
    await w.dispatch("notificationclick", { notification: { close, data: payload } });
    expect(close).toHaveBeenCalled();
    expect(w.openWindow).toHaveBeenCalledWith("https://app.example/environment/thread%3Aone");
  });
  it("navigates and focuses an existing same-origin client", async () => {
    const w = worker();
    const focus = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn().mockResolvedValue({ focus });
    w.matchAll.mockResolvedValue([
      { url: "https://foreign.example", navigate },
      { url: "https://app.example/", navigate },
    ]);
    await w.dispatch("notificationclick", { notification: { close: vi.fn(), data: payload } });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });
});
