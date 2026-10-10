import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { useWebPush } from "../../hooks/useWebPush";
import { webPushEnvironment } from "../../state/webPush";
import { webPushUnsupportedReason } from "../../webPush";
import { Button } from "../ui/button";
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unsupported = webPushUnsupportedReason();
  const denied = !unsupported && Notification.permission === "denied";
  const act = (action: "enable" | "disable" | "test") => {
    if (busy) return;
    // Start the permission request directly in the click gesture, before RPC or lock awaits.
    const permission = action === "enable" ? Notification.requestPermission() : null;
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
            ? "Background push disabled for this machine."
            : "Background push enabled for this machine on this device.",
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
        message ??
        (denied
          ? "Notifications are blocked. Allow this site in Android or browser notification settings before enabling push."
          : enabled
            ? "Enabled for this machine on this device. Installed Android web apps can receive alerts while T3 Code is closed; delivery and reopening depend on the browser and OS."
            : "Not enabled. Install T3 Code in a supported Android browser to receive system alerts while the app is closed. This is separate from alerts while T3 Code is open.")
      }
      control={
        unsupported ? undefined : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || enabled || denied || !canRegister}
              onClick={() => act("enable")}
            >
              Enable
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !canUnregister}
              onClick={() => act("disable")}
            >
              Disable
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !enabled || !canTest}
              onClick={() => act("test")}
            >
              Test
            </Button>
          </div>
        )
      }
    />
  );
}
