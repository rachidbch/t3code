/* Dedicated push worker: deliberately no fetch handler or offline cache. */
function validId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u0020]/.test(value)
  );
}
function payloadForScope(value) {
  if (
    !value ||
    value.version !== 1 ||
    !validId(value.environmentId) ||
    (value.threadId !== undefined && !validId(value.threadId)) ||
    !["completion", "input", "approval", "failed", "test"].includes(value.kind) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 200 ||
    (value.body !== undefined && (typeof value.body !== "string" || value.body.length > 2000)) ||
    typeof value.tag !== "string" ||
    !value.tag ||
    value.tag.length > 300
  )
    return null;
  const expected = new URL(
    `/web-push/${encodeURIComponent(value.environmentId)}/`,
    self.location.origin,
  ).href;
  return self.registration.scope === expected ? value : null;
}
self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = payloadForScope(event.data?.json());
  } catch {
    return;
  }
  if (!payload) return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/apple-touch-icon.png",
      badge: "/favicon-32x32.png",
      data: { version: 1, environmentId: payload.environmentId, threadId: payload.threadId },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (
    !data ||
    data.version !== 1 ||
    !validId(data.environmentId) ||
    (data.threadId !== undefined && !validId(data.threadId)) ||
    self.registration.scope !==
      new URL(`/web-push/${encodeURIComponent(data.environmentId)}/`, self.location.origin).href
  )
    return;
  const target = new URL(
    data.threadId
      ? `/${encodeURIComponent(data.environmentId)}/${encodeURIComponent(data.threadId)}`
      : "/",
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const navigated = await client.navigate(target);
          if (navigated) {
            await navigated.focus();
            return;
          }
        } catch {
          /* A closing window may no longer be navigable. */
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
