import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useWebPush } from "../../hooks/useWebPush";
import { webPushEnvironment } from "../../state/webPush";
import { environmentSession } from "../../state/session";
import { webPushUnsupportedReason } from "../../webPush";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function WebPushSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  if (!environmentId)
    return (
      <SettingsRow
        {...searchableSetting("background-web-push")}
        description="Select one machine to manage this device's background push notifications."
      />
    );
  return <EnvironmentWebPushSettings key={environmentId} environmentId={environmentId} />;
}
function EnvironmentWebPushSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { lifecycle, enabled, lock } = useWebPush(environmentId);
  const canRegister = useAtomValue(webPushEnvironment.register.permissionAtom(environmentId));
  const canUnregister = useAtomValue(webPushEnvironment.unregister.permissionAtom(environmentId));
  const canTest = useAtomValue(webPushEnvironment.test.permissionAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const grant = Option.getOrNull(AsyncResult.value(session));
  const canChange = enabled ? canUnregister : canRegister;
  const connectionProblem = AsyncResult.isFailure(session)
    ? "Could not verify this connection's permissions. Reconnect to this machine and try again."
    : grant === null
      ? "Connecting to this machine and checking permissions…"
      : !grant.authenticated
        ? "Pair with this machine again to enable background notifications."
        : !canChange
          ? "This connection needs permission to read threads and change settings. Re-pair with those permissions to enable background notifications."
          : null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unsupported = webPushUnsupportedReason();
  const denied = !unsupported && Notification.permission === "denied";
  const act = (action: "enable" | "disable" | "test") => {
    if (busy) return;
    if (action === "enable" && Notification.permission === "denied") {
      setMessage(
        "Notifications are blocked. Allow this site in Android or browser notification settings, then turn this switch on again.",
      );
      return;
    }
    // Start the permission request directly in the click gesture, before RPC or lock awaits.
    let permission: Promise<NotificationPermission> | null = null;
    try {
      if (action === "enable") permission = Notification.requestPermission();
    } catch {
      setMessage(
        "This browser could not request notification permission. Check its site settings and try again.",
      );
      return;
    }
    setBusy(true);
    setMessage(null);
    void lock(async () => {
      if (action === "enable" && permission) await lifecycle.enable(permission);
      else if (action === "disable") await lifecycle.disable();
      else await lifecycle.test();
      setMessage(
        action === "test"
          ? "Test push requested. Check your system notifications."
          : action === "disable"
            ? "Background notifications are off for this device."
            : "Background notifications are on for this device.",
      );
    })
      .catch((error: unknown) => {
        setMessage(
          error instanceof Error
            ? error.message
            : "Push failed. Check the machine connection, re-pair if needed, and retry.",
        );
      })
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      {...searchableSetting("background-web-push")}
      description={
        unsupported ??
        connectionProblem ??
        (busy ? "Updating background notifications…" : null) ??
        message ??
        (denied
          ? "Blocked by your browser. Allow notifications for this site in browser settings, then turn this on."
          : "Alerts when a thread finishes or needs your attention, even with T3 Code closed.")
      }
      control={
        <div className="flex items-center gap-3 @min-[32rem]/settings-row:flex-row-reverse">
          <Switch
            aria-label="Background notifications"
            checked={enabled}
            disabled={busy || Boolean(unsupported) || !canChange}
            onCheckedChange={(checked) => act(checked ? "enable" : "disable")}
          />
          {enabled && !unsupported && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canTest}
              onClick={() => act("test")}
            >
              Test notification
            </Button>
          )}
        </div>
      }
    />
  );
}
