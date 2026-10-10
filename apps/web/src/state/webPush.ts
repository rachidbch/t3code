import { createWebPushEnvironmentAtoms } from "@t3tools/client-runtime/state/web-push";
import { connectionAtomRuntime } from "../connection/runtime";

export const webPushEnvironment = createWebPushEnvironmentAtoms(connectionAtomRuntime);
