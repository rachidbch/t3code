import {
  AuthSessionId,
  ThreadId,
  WebPushError,
  WebPushPayload,
  WebPushSubscription,
  type WebPushRegisterInput,
  type OrchestrationV2ThreadShell,
  type EnvironmentId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WebPushSender from "./WebPushSender.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";

export class WebPush extends Context.Service<
  WebPush,
  {
    readonly getConfig: Effect.Effect<{ publicKey: string }, WebPushError>;
    readonly getDevice: (
      sessionId: AuthSessionId,
      deviceId: string,
    ) => Effect.Effect<{ enabled: boolean }, WebPushError>;
    readonly register: (
      sessionId: AuthSessionId,
      input: WebPushRegisterInput,
    ) => Effect.Effect<{ enabled: boolean }, WebPushError>;
    readonly unregister: (
      sessionId: AuthSessionId,
      deviceId: string,
    ) => Effect.Effect<void, WebPushError>;
    readonly test: (
      sessionId: AuthSessionId,
      deviceId: string,
    ) => Effect.Effect<void, WebPushError>;
    /** Replay committed events and finish currently due deliveries, without waiting for retry timers. */
    readonly drain: Effect.Effect<void, WebPushError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/webPush/WebPush") {}

// Only browser push services are destinations, never arbitrary user-provided HTTPS servers.
// An allowlist avoids DNS rebinding and redirects to private hosts as well as IP literals.
export function validPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
function validOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
function validKeys(keys: WebPushRegisterInput["subscription"]["keys"]): boolean {
  const decode = (key: string) =>
    /^[A-Za-z0-9_-]+$/.test(key) ? Buffer.from(key, "base64url") : Buffer.alloc(0);
  const publicKey = decode(keys.p256dh);
  return publicKey.length === 65 && publicKey[0] === 4 && decode(keys.auth).length === 16;
}

export function notificationForThread(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): { identity: string; payload: WebPushPayload } | null {
  const awareness = projectThreadAwarenessV2({ environmentId, project: { title: "" }, thread });
  const kind =
    awareness?.phase === "completed"
      ? "completion"
      : awareness?.phase === "failed"
        ? "failed"
        : awareness?.phase === "waiting_for_input"
          ? "input"
          : awareness?.phase === "waiting_for_approval"
            ? "approval"
            : null;
  if (!kind || !awareness) return null;
  const workId =
    kind === "input" || kind === "approval" ? thread.pendingRuntimeRequest?.id : thread.latestRunId;
  if (!workId) return null;
  const identity = `${thread.id}:${kind}:${workId}`;
  return {
    identity,
    payload: {
      version: 1,
      environmentId,
      threadId: thread.id,
      kind,
      title: "T3 Code",
      body: awareness.headline,
      tag: identity,
    },
  };
}
const encodePayload = Schema.encodeSync(Schema.fromJsonString(WebPushPayload));
const encodeSubscription = Schema.encodeSync(Schema.fromJsonString(WebPushSubscription));
const decodePayload = Schema.decodeEffect(Schema.fromJsonString(WebPushPayload));
const decodeSubscription = Schema.decodeEffect(Schema.fromJsonString(WebPushSubscription));
const isWebPushError = Schema.is(WebPushError);
const watchCount = (thread: Pick<OrchestrationV2ThreadShell, "pullRequests">) =>
  (thread.pullRequests ?? []).filter(
    (link) => link.watch !== undefined && link.source !== "stack-dismissed",
  ).length;

interface DeviceRow {
  readonly device_id: string;
  readonly session_id: string;
  readonly subscription: string;
  readonly after_sequence: number;
}
interface DeliveryRow {
  readonly device_id: string;
  readonly identity: string;
  readonly payload: string;
  readonly attempts: number;
  readonly expires_at: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const sender = yield* WebPushSender.WebPushSender;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const lock = yield* Semaphore.make(1);
  const safeStorage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isWebPushError(error) ? error : new WebPushError({ reason: "storage", cause: error }),
      ),
    );
  const authorized = Effect.fnUntraced(function* (sessionId: AuthSessionId) {
    const session = yield* safeStorage(sessions.getById({ sessionId }));
    const now = yield* DateTime.now;
    return (
      Option.isSome(session) &&
      session.value.revokedAt === null &&
      session.value.expiresAt.epochMilliseconds > now.epochMilliseconds &&
      session.value.scopes.includes("orchestration:read") &&
      session.value.scopes.includes("settings:write")
    );
  });
  const requireAuthorized = Effect.fnUntraced(function* (id: AuthSessionId) {
    if (!(yield* authorized(id))) return yield* new WebPushError({ reason: "unauthorized" });
  });
  const owned = Effect.fnUntraced(function* (sessionId: AuthSessionId, deviceId: string) {
    const rows = yield* safeStorage(
      sql<DeviceRow>`SELECT * FROM web_push_devices WHERE device_id = ${deviceId}`,
    );
    if (rows[0] && rows[0].session_id !== sessionId)
      return yield* new WebPushError({ reason: "ownership" });
    return rows[0];
  });
  const removeDevice = (deviceId: string) =>
    safeStorage(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM web_push_deliveries WHERE device_id = ${deviceId}`;
          yield* sql`DELETE FROM web_push_devices WHERE device_id = ${deviceId}`;
        }),
      ),
    );
  const insert = (
    deviceId: string,
    notification: { identity: string; payload: WebPushPayload },
    now: number,
    status = "pending",
    expiresAt = now + 300_000,
  ) =>
    sql`INSERT OR IGNORE INTO web_push_deliveries (device_id, identity, payload, status, due_at, expires_at) VALUES (${deviceId}, ${notification.identity}, ${encodePayload(notification.payload)}, ${status}, ${now}, ${expiresAt})`;
  const replay = Effect.gen(function* () {
    const devicesPresent = yield* safeStorage(sql`SELECT device_id FROM web_push_devices LIMIT 1`);
    if (devicesPresent.length === 0) return;
    const cursor = yield* safeStorage(
      sql<{ sequence: number }>`SELECT sequence FROM web_push_cursor WHERE id = 1`,
    );
    if (!cursor[0]) return;
    let sequence = cursor[0].sequence;
    const throughSequence = yield* safeStorage(events.latestSequence());
    const watchRows = yield* safeStorage(
      sql<{ thread_id: string; watch_count: number }>`SELECT * FROM web_push_watch_state`,
    );
    const watches = new Map(watchRows.map((row) => [row.thread_id, row.watch_count]));
    const changedWatches = new Set<ThreadId>();
    // Collapse the bounded catch-up before reading current projections. A held completion's
    // release may be in a later page; marking it expired from an earlier page would suppress it.
    const affected = new Map<
      ThreadId,
      { sequence: number; expiresAt: number; type: string; runId?: string }
    >();
    while (sequence < throughSequence) {
      const batch = yield* safeStorage(
        Stream.runCollect(events.read({ afterSequence: sequence, throughSequence, limit: 200 })),
      );
      if (batch.length === 0) break;
      for (const stored of batch) {
        const event = stored.event;
        let watchReleased = false;
        if (event.type === "thread.pull-request-synced") {
          const count = watchCount(event.payload);
          watchReleased = (watches.get(event.threadId) ?? 0) > 0 && count === 0;
          watches.set(event.threadId, count);
          changedWatches.add(event.threadId);
        }
        const metadataOnly =
          event.type.startsWith("thread.") && event.type !== "thread.pull-request-synced";
        const commandExit =
          event.type === "turn-item.updated" && event.payload.type === "command_execution";
        // A `secret_request` turn item is the pending user input for MCP tools
        // like request_secret: no run state changes when it starts waiting, so
        // without this item event the waiting-for-input phase is never
        // re-evaluated and the input notification never fires.
        const secretRequestItem =
          event.type === "turn-item.updated" && event.payload.type === "secret_request";
        if (
          (shouldPublishAgentAwarenessEvent(event) || secretRequestItem) &&
          !metadataOnly &&
          !commandExit &&
          (event.type !== "thread.pull-request-synced" || watchReleased)
        ) {
          const run =
            event.type === "run.created" || event.type === "run.updated" ? event.payload : null;
          affected.set(event.threadId, {
            sequence: stored.sequence,
            expiresAt:
              Math.min(
                event.occurredAt.epochMilliseconds,
                (run?.completedAt ?? event.occurredAt).epochMilliseconds,
              ) + 300_000,
            type: event.type,
            ...(run ? { runId: run.id } : {}),
          });
        }
        sequence = stored.sequence;
      }
    }
    // Notification identities, including expired milestones, and the cursor commit together.
    yield* safeStorage(
      sql.withTransaction(
        Effect.gen(function* () {
          const devices = yield* sql<DeviceRow>`SELECT * FROM web_push_devices`;
          for (const threadId of changedWatches) {
            const count = watches.get(threadId) ?? 0;
            yield* sql`INSERT INTO web_push_watch_state (thread_id, watch_count) VALUES (${threadId}, ${count}) ON CONFLICT(thread_id) DO UPDATE SET watch_count = excluded.watch_count`;
          }
          for (const [threadId, source] of affected) {
            const now = (yield* DateTime.now).epochMilliseconds;
            const shell = yield* threads.getThreadShell(threadId);
            const notification =
              shell && shell.archivedAt === null
                ? notificationForThread(environmentId, shell)
                : null;
            if (!notification || (source.runId && source.runId !== shell?.latestRunId)) continue;
            if (
              notification.payload.kind === "completion" &&
              source.type === "runtime-request.updated"
            )
              continue;
            for (const device of devices) {
              if (source.sequence > device.after_sequence)
                yield* insert(
                  device.device_id,
                  notification,
                  now,
                  source.expiresAt <= now ? "expired" : "pending",
                  source.expiresAt,
                );
            }
          }
          yield* sql`UPDATE web_push_cursor SET sequence = ${sequence} WHERE id = 1`;
        }),
      ),
    );
  });
  const deliver = Effect.gen(function* () {
    const now = (yield* DateTime.now).epochMilliseconds;
    yield* safeStorage(
      sql`UPDATE web_push_deliveries SET status = 'expired' WHERE status = 'pending' AND expires_at <= ${now}`,
    );
    // Keep the latest identity per device/thread for deduplication, not an unbounded delivery history.
    yield* safeStorage(sql`
      DELETE FROM web_push_deliveries
      WHERE status != 'pending' AND expires_at < ${now - 86_400_000}
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM web_push_deliveries
          GROUP BY device_id, json_extract(payload, '$.threadId')
        )
    `);
    const deliveries = yield* safeStorage(
      sql<DeliveryRow>`SELECT * FROM web_push_deliveries WHERE status = 'pending' AND due_at <= ${now} ORDER BY due_at LIMIT 100`,
    );
    for (const delivery of deliveries) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const now = (yield* DateTime.now).epochMilliseconds;
          const pending = yield* safeStorage(
            sql`SELECT 1 FROM web_push_deliveries WHERE device_id = ${delivery.device_id} AND identity = ${delivery.identity} AND status = 'pending'`,
          );
          if (pending.length === 0) return;
          if (delivery.expires_at <= now) {
            yield* safeStorage(
              sql`UPDATE web_push_deliveries SET status = 'expired' WHERE device_id = ${delivery.device_id} AND identity = ${delivery.identity}`,
            );
            return;
          }
          const rows = yield* safeStorage(
            sql<DeviceRow>`SELECT * FROM web_push_devices WHERE device_id = ${delivery.device_id}`,
          );
          const device = rows[0];
          if (!device) return;
          if (!(yield* authorized(AuthSessionId.make(device.session_id)))) {
            yield* removeDevice(device.device_id);
            return;
          }
          const payload = yield* safeStorage(decodePayload(delivery.payload));
          // Resolved requests and superseded runs must not surface after a delayed retry or restart.
          if (payload.threadId) {
            const shell = yield* safeStorage(
              threads.getThreadShell(ThreadId.make(payload.threadId)),
            );
            const current =
              shell && shell.archivedAt === null
                ? notificationForThread(environmentId, shell)
                : null;
            if (current?.identity !== delivery.identity) {
              yield* safeStorage(
                sql`UPDATE web_push_deliveries SET status = 'cancelled' WHERE device_id = ${device.device_id} AND identity = ${delivery.identity}`,
              );
              return;
            }
          }
          const subscription = yield* safeStorage(decodeSubscription(device.subscription));
          if (!validPushEndpoint(subscription.endpoint)) {
            yield* removeDevice(device.device_id);
            return;
          }
          const status = yield* sender
            .send(
              subscription,
              payload,
              Math.max(1, Math.floor((delivery.expires_at - now) / 1000)),
            )
            .pipe(Effect.orElseSucceed(() => 503));
          if (status === 404 || status === 410) {
            yield* removeDevice(device.device_id);
            return;
          }
          const attempts = delivery.attempts + 1;
          const retry = (status === 429 || status >= 500) && attempts < 5;
          yield* safeStorage(
            sql`UPDATE web_push_deliveries SET status = ${status >= 200 && status < 300 ? "sent" : retry ? "pending" : "failed"}, attempts = ${attempts}, due_at = ${now + Math.min(120_000, 1000 * 2 ** attempts)} WHERE device_id = ${device.device_id} AND identity = ${delivery.identity}`,
          );
        }),
      );
      // Let queued preference changes run before acquiring the next delivery's permit.
      yield* Effect.yieldNow;
    }
  });
  const deliveryLock = yield* Semaphore.make(1);
  const drain = deliveryLock.withPermits(1)(
    lock.withPermits(1)(replay).pipe(Effect.andThen(deliver)),
  );
  let queued = false;
  const worker = yield* makeDrainableWorker(() =>
    Effect.sync(() => {
      queued = false;
    }).pipe(
      Effect.andThen(drain),
      Effect.catch(() => Effect.logWarning("Web Push worker could not finish its batch.")),
    ),
  );
  const enqueue = Effect.suspend(() => {
    if (queued) return Effect.void;
    queued = true;
    return worker.enqueue(undefined).pipe(Effect.asVoid);
  });
  return WebPush.of({
    getConfig: sender.getConfig,
    getDevice: Effect.fn("WebPush.getDevice")(function* (sessionId, deviceId) {
      const rows = yield* safeStorage(
        sql<DeviceRow>`SELECT * FROM web_push_devices WHERE device_id = ${deviceId} AND session_id = ${sessionId}`,
      );
      return { enabled: rows.length > 0 && (yield* authorized(sessionId)) };
    }),
    register: (sessionId, input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireAuthorized(sessionId);
          if (
            !validPushEndpoint(input.subscription.endpoint) ||
            !validOrigin(input.origin) ||
            !validKeys(input.subscription.keys)
          )
            return yield* new WebPushError({ reason: "invalid" });
          return yield* safeStorage(
            sql.withTransaction(
              Effect.gen(function* () {
                const existing =
                  (yield* sql<DeviceRow>`SELECT * FROM web_push_devices WHERE device_id = ${input.deviceId}`)[0];
                if (existing && existing.session_id !== sessionId) {
                  // Re-pair may repair a revoked/expired owner only with the same secret subscription.
                  if (
                    (yield* authorized(AuthSessionId.make(existing.session_id))) ||
                    existing.subscription !== encodeSubscription(input.subscription)
                  ) {
                    return yield* new WebPushError({ reason: "ownership" });
                  }
                }
                const endpoints =
                  yield* sql<DeviceRow>`SELECT * FROM web_push_devices WHERE endpoint = ${input.subscription.endpoint}`;
                if (endpoints[0] && endpoints[0].device_id !== input.deviceId)
                  return yield* new WebPushError({ reason: "ownership" });
                const sequence = yield* events.latestSequence();
                yield* sql`INSERT OR IGNORE INTO web_push_cursor (id, sequence) VALUES (1, ${sequence})`;
                yield* sql`INSERT INTO web_push_devices (device_id, session_id, origin, subscription, endpoint, after_sequence) VALUES (${input.deviceId}, ${sessionId}, ${input.origin}, ${encodeSubscription(input.subscription)}, ${input.subscription.endpoint}, ${sequence}) ON CONFLICT(device_id) DO UPDATE SET session_id = excluded.session_id, origin = excluded.origin, subscription = excluded.subscription, endpoint = excluded.endpoint`;
                if (!existing) {
                  const snapshot = yield* threads.getShellSnapshot();
                  const now = (yield* DateTime.now).epochMilliseconds;
                  for (const thread of snapshot.threads) {
                    yield* sql`INSERT OR IGNORE INTO web_push_watch_state (thread_id, watch_count) VALUES (${thread.id}, ${watchCount(thread)})`;
                    const notification = notificationForThread(environmentId, thread);
                    if (notification) yield* insert(input.deviceId, notification, now, "baseline");
                  }
                }
                return { enabled: true };
              }),
            ),
          );
        }),
      ),
    unregister: (sessionId, deviceId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireAuthorized(sessionId);
          yield* owned(sessionId, deviceId);
          yield* removeDevice(deviceId);
        }),
      ),
    test: (sessionId, deviceId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireAuthorized(sessionId);
          const device = yield* owned(sessionId, deviceId);
          if (!device) return yield* new WebPushError({ reason: "invalid" });
          const now = (yield* DateTime.now).epochMilliseconds;
          const identity = `test:${now}`;
          yield* safeStorage(
            insert(
              deviceId,
              {
                identity,
                payload: {
                  version: 1,
                  environmentId,
                  kind: "test",
                  title: "T3 Code",
                  body: "Background notifications are working.",
                  tag: identity,
                },
              },
              now,
            ),
          );
          yield* enqueue;
        }),
      ),
    drain,
    start: () =>
      Effect.gen(function* () {
        yield* threads.streamDomainEvents.pipe(
          Stream.filter(shouldPublishAgentAwarenessEvent),
          Stream.runForEach(() => enqueue),
          Effect.forkScoped,
        );
        // Subscribe before replay so an event committed during catch-up cannot be lost.
        yield* enqueue;
        yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(enqueue))).pipe(
          Effect.forkScoped,
        );
      }),
  });
});
export const layer = Layer.effect(WebPush, make).pipe(
  Layer.provide(Layer.merge(AuthSessions.layer, EventStore.layer)),
);
