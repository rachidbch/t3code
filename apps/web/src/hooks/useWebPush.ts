import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { environmentSession } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { webPushEnvironment } from "../state/webPush";
import {
  createWebPushLifecycle,
  isWebPushConfirmed,
  setWebPushConfirmed,
  subscribeWebPush,
  WEB_PUSH_STORAGE_PREFIX,
  webPushUnsupportedReason,
  withWebPushLock,
} from "../webPush";

async function unwrap<A, E>(result: Promise<AtomCommandResult<A, E>>): Promise<A> {
  const settled = await result;
  if (AsyncResult.isSuccess(settled)) return settled.value;
  const error = Cause.squash(settled.cause);
  throw error instanceof Error
    ? error
    : new Error(
        "Push request failed. Check this machine's connection and permissions, then retry.",
      );
}
export function useWebPush(environmentId: EnvironmentId) {
  const config = useAtomCommand(webPushEnvironment.getConfig, { reportFailure: false });
  const device = useAtomCommand(webPushEnvironment.getDevice, { reportFailure: false });
  const register = useAtomCommand(webPushEnvironment.register, { reportFailure: false });
  const unregister = useAtomCommand(webPushEnvironment.unregister, { reportFailure: false });
  const test = useAtomCommand(webPushEnvironment.test, { reportFailure: false });
  const lifecycle = useMemo(
    () =>
      createWebPushLifecycle(environmentId, {
        getConfig: () => unwrap(config({ environmentId, input: undefined })),
        getDevice: (deviceId) => unwrap(device({ environmentId, input: { deviceId } })),
        register: (input) => unwrap(register({ environmentId, input })),
        unregister: (deviceId) => unwrap(unregister({ environmentId, input: { deviceId } })),
        test: (deviceId) => unwrap(test({ environmentId, input: { deviceId } })),
      }),
    [environmentId, config, device, register, unregister, test],
  );
  const enabled = useSyncExternalStore(
    subscribeWebPush,
    () => isWebPushConfirmed(environmentId),
    () => false,
  );
  return {
    lifecycle,
    enabled,
    lock: <A>(action: () => Promise<A>) => withWebPushLock(environmentId, action),
  };
}

// Mount once per connected environment, including after pairing changes the session.
export function WebPushReconciler({ environmentId }: { environmentId: EnvironmentId }) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const { lifecycle } = useWebPush(environmentId);
  useEffect(() => {
    if (webPushUnsupportedReason()) return;
    let disposed = false;
    const reconcile = () => {
      if (!AsyncResult.isSuccess(session) || !session.value.authenticated) {
        setWebPushConfirmed(environmentId, false);
        return;
      }
      void withWebPushLock(environmentId, async () => {
        if (!disposed) await lifecycle.reconcile();
      }).catch(() => {
        setWebPushConfirmed(environmentId, false);
      });
    };
    reconcile();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(`${WEB_PUSH_STORAGE_PREFIX}${environmentId}:`))
        reconcile();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
    };
  }, [environmentId, lifecycle, session]);
  return null;
}
