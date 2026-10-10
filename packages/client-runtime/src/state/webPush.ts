import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createWebPushEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  return {
    getConfig: createEnvironmentRpcCommand(runtime, {
      label: "web-push:config",
      tag: WS_METHODS.webPushGetConfig,
    }),
    getDevice: createEnvironmentRpcCommand(runtime, {
      label: "web-push:device",
      tag: WS_METHODS.webPushGetDevice,
    }),
    register: createEnvironmentRpcCommand(runtime, {
      label: "web-push:register",
      tag: WS_METHODS.webPushRegister,
    }),
    unregister: createEnvironmentRpcCommand(runtime, {
      label: "web-push:unregister",
      tag: WS_METHODS.webPushUnregister,
    }),
    test: createEnvironmentRpcCommand(runtime, {
      label: "web-push:test",
      tag: WS_METHODS.webPushTest,
    }),
  };
}
