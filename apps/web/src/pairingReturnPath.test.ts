import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  rememberPairingReturnPath,
  safePairingReturnPath,
  takePairingReturnPath,
} from "./pairingReturnPath";
afterEach(() => vi.unstubAllGlobals());
describe("notification destination through pairing", () => {
  it("preserves a thread destination once, including encoded provider IDs", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      setItem: (k: string, v: string) => storage.set(k, v),
      getItem: (k: string) => storage.get(k) ?? null,
      removeItem: (k: string) => storage.delete(k),
    });
    rememberPairingReturnPath("/environment/thread%3Aone");
    expect(takePairingReturnPath()).toBe("/environment/thread%3Aone");
    expect(takePairingReturnPath()).toBe("/");
  });
  it.each([
    "//attacker.example/a",
    "https://attacker.example/a",
    "/pair",
    "/a/../b",
    "/a/b?credential=secret",
  ])("rejects unsafe/non-thread destination %s", (path) =>
    expect(safePairingReturnPath(path)).toBe("/"),
  );
});
