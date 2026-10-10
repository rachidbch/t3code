# Web app notifications

On a supported browser, background web push delivers system notifications when a thread finishes,
fails, or needs input or approval—even when the web app is closed. It works with all providers.
It does not require the native mobile app or T3 Connect.

Open T3 Code over HTTPS. In **Settings → General**, select the environment you want notifications
from, then enable **Background web push** and allow notifications when your browser asks. Use
**Test** to check delivery. Enable it separately for each environment and browser/device.

On Android, use a supported browser such as Chrome and install T3 Code on your home screen.
Tapping a notification opens its thread. If your session expired, pair again; if the environment
is unreachable, reconnect before opening the conversation. Notifications do not include thread
names or conversation content.

Background web push is separate from **Thread notifications**, which applies while T3 Code is
open. When background push is enabled, T3 Code avoids sending a second page-generated system
notification for the same environment. In-app alerts and sounds keep their existing settings.

Choose **Disable** to stop this environment's push notifications on this device. Notification
permission and sound are controlled separately in Android/browser settings. Force-stopping the
browser, disabling notifications, losing connectivity, or battery restrictions can prevent or delay
delivery. Delayed notifications expire rather than being delivered indefinitely.

The server must remain running and have internet access to the browser's push service. Using the
web app through Tailscale HTTPS is supported. Your phone still needs access to the environment
when you tap a notification, even if the notification itself arrived without that connection.

For the native Android or iOS app, see [Mobile notifications](mobile-notifications.md).
