import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadShell,
  type WebPushPayload,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WebPush from "./WebPush.ts";
import * as Sender from "./WebPushSender.ts";
const threadId = ThreadId.make("thread");
const environmentId = EnvironmentId.make("environment");
const owner = AuthSessionId.make("owner");
const deviceId = "11111111-1111-4111-8111-111111111111";
const watchedPr = {
  host: "github.com",
  repository: "owner/repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  source: "manual",
  linkedAt: "2026-10-09T00:00:00.000Z",
  snapshot: null,
  stack: null,
  watch: {
    startedAt: "2026-10-09T00:00:00.000Z",
    remarksThrough: "2026-10-09T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
} satisfies ThreadPullRequestLink;
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/private",
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"),
    auth: Buffer.alloc(16, 2).toString("base64url"),
  },
};
function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe("2026-10-09T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-09T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const harness = Effect.gen(function* () {
  let current = shell({ status: "completed", latestRunId: RunId.make("old") });
  let response = 201;
  const sent: WebPushPayload[] = [];
  const ttls: number[] = [];
  let onSend = () => Effect.void;
  const layer = WebPush.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        EventStore.layer,
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.sync(() => current),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              threads: [current],
              archivedThreads: [],
              snapshotSequence: 0,
            }),
          streamDomainEvents: Stream.never,
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.succeed(Sender.WebPushSender, {
          getConfig: Effect.succeed({ publicKey: "public" }),
          send: (_subscription, payload, ttl) =>
            Effect.gen(function* () {
              sent.push(payload);
              ttls.push(ttl);
              yield* onSend();
              return response;
            }),
        }),
      ),
    ),
  );
  const service = yield* WebPush.WebPush.pipe(Effect.provide(layer));
  const events = yield* EventStore.EventStoreV2.pipe(Effect.provide(EventStore.layer));
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  for (const id of [owner, "other"])
    yield* sql`INSERT INTO auth_sessions (session_id, subject, method, issued_at, expires_at, revoked_at, client_device_type, scopes) VALUES (${id}, 'test', 'browser-session-cookie', ${DateTime.formatIso(now)}, ${DateTime.formatIso(DateTime.add(now, { days: 1 }))}, NULL, 'unknown', '["settings:write","orchestration:read"]')`;
  let ordinal = 0;
  const event = Effect.fnUntraced(function* (
    overrides: Partial<OrchestrationV2ThreadShell> = {},
    occurredAt?: DateTime.Utc,
  ) {
    current = shell({ ...current, ...overrides });
    ordinal++;
    yield* events.append({
      events: [
        {
          id: EventId.make(`event-${ordinal}`),
          threadId,
          type: "run.updated",
          occurredAt: occurredAt ?? (yield* DateTime.now),
          payload: {
            id: current.latestRunId ?? RunId.make("run"),
            threadId,
            ordinal,
            providerInstanceId: current.providerInstanceId,
            modelSelection: current.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });
  const register = () =>
    service.register(owner, { deviceId, origin: "https://app.example", subscription });
  return {
    service,
    ttls,
    setOnSend: (hook: () => Effect.Effect<void>) => {
      onSend = hook;
    },
    setShell: (overrides: Partial<OrchestrationV2ThreadShell>) => {
      current = shell({ ...current, ...overrides });
    },
    commandExit: () =>
      DateTime.now.pipe(
        Effect.flatMap((occurredAt) =>
          events.append({
            events: [
              {
                id: EventId.make(`command-${++ordinal}`),
                threadId,
                type: "turn-item.updated",
                occurredAt,
                payload: {
                  id: TurnItemId.make("command"),
                  threadId,
                  runId: current.latestRunId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 1,
                  title: null,
                  startedAt: now,
                  completedAt: occurredAt,
                  updatedAt: occurredAt,
                  type: "command_execution",
                  status: "completed",
                  input: "development server",
                  exitCode: 0,
                },
              },
            ],
          }),
        ),
      ),
    secretRequest: () =>
      DateTime.now.pipe(
        Effect.flatMap((occurredAt) =>
          events.append({
            events: [
              {
                id: EventId.make(`secret-${++ordinal}`),
                threadId,
                type: "turn-item.updated",
                occurredAt,
                payload: {
                  id: TurnItemId.make("secret-item"),
                  threadId,
                  runId: current.latestRunId,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "waiting",
                  title: null,
                  startedAt: occurredAt,
                  completedAt: null,
                  updatedAt: occurredAt,
                  type: "secret_request",
                  label: "Push test",
                  reason: "Verifying input notifications",
                  secretStatus: "pending",
                },
              },
            ],
          }),
        ),
      ),
    metadata: (
      type: "thread.metadata-updated" | "thread.pull-request-synced" = "thread.metadata-updated",
      count = 1,
    ) =>
      DateTime.now.pipe(
        Effect.flatMap((occurredAt) =>
          events.append({
            events: Array.from({ length: count }, () => ({
              id: EventId.make(`metadata-${++ordinal}`),
              threadId,
              type,
              occurredAt,
              payload: { ...current, lastVisitedAt: current.lastVisitedAt ?? null },
            })),
          }),
        ),
      ),
    restart: WebPush.WebPush.pipe(Effect.provide(layer)),
    register,
    event,
    sql,
    sent,
    setResponse: (status: number) => {
      response = status;
    },
  };
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer))),
  );
describe("durable web push", () => {
  it.effect("baselines history, deduplicates replays and notifies successive completed runs", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        yield* h.event();
        yield* h.service.drain;
        expect(h.sent).toHaveLength(0);
        yield* h.event({ latestRunId: RunId.make("new") });
        yield* h.service.drain;
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatchObject({ kind: "completion", threadId, body: "Agent finished" });
        yield* h.event({ latestRunId: RunId.make("next") });
        yield* h.service.drain;
        expect(h.sent).toHaveLength(2);
      }),
    ),
  );
  it.effect("recovers committed completion and retry delivery after a worker restart", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        h.setResponse(503);
        yield* h.event({ latestRunId: RunId.make("new") });
        const restarted = yield* h.restart;
        yield* restarted.drain;
        expect(h.sent).toHaveLength(1);
        h.setResponse(201);
        yield* TestClock.adjust("5 seconds");
        const recovered = yield* h.restart;
        yield* recovered.drain;
        yield* recovered.drain;
        expect(h.sent).toHaveLength(2);
        expect(
          (yield* h.sql<{
            status: string;
          }>`SELECT status FROM web_push_deliveries WHERE identity LIKE '%completion:new'`)[0]
            ?.status,
        ).toBe("sent");
      }),
    ),
  );
  it.effect(
    "prunes old delivery history while retaining the latest identity for deduplication",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* h.register();
          yield* h.event({ latestRunId: RunId.make("new") });
          yield* h.service.drain;
          expect(yield* h.sql`SELECT * FROM web_push_deliveries`).toHaveLength(2);
          yield* TestClock.adjust("2 days");
          yield* h.service.drain;
          const rows = yield* h.sql<{ identity: string }>`SELECT identity FROM web_push_deliveries`;
          expect(rows).toHaveLength(1);
          expect(rows[0]?.identity).toContain("completion:new");
        }),
      ),
  );
  it.effect("does not revive an expired completion when thread metadata changes", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        yield* h.event({ latestRunId: RunId.make("new") });
        yield* TestClock.adjust("6 minutes");
        yield* h.service.drain;
        yield* h.metadata();
        yield* h.service.drain;
        expect(h.sent).toHaveLength(0);
      }),
    ),
  );
  it.effect("does not revive an expired completion when a long-lived command exits", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        yield* h.event({ latestRunId: RunId.make("new") });
        yield* TestClock.adjust("6 minutes");
        yield* h.service.drain;
        yield* h.commandExit();
        yield* h.service.drain;
        expect(h.sent).toHaveLength(0);
        expect(
          (yield* h.sql<{
            status: string;
          }>`SELECT status FROM web_push_deliveries WHERE identity LIKE '%completion:new'`)[0]
            ?.status,
        ).toBe("expired");
      }),
    ),
  );
  it.effect("does not revive an expired unheld completion on a PR metadata sync", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        yield* h.event({ latestRunId: RunId.make("new") });
        yield* TestClock.adjust("6 minutes");
        yield* h.metadata("thread.pull-request-synced");
        yield* h.service.drain;
        expect(h.sent).toHaveLength(0);
      }),
    ),
  );
  it.effect("notifies waiting-for-input when a secret request turn item starts waiting", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        h.setShell({
          status: "running",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("secret-item"),
            kind: "user_input",
            createdAt: yield* DateTime.now,
          },
        });
        yield* h.secretRequest();
        yield* h.service.drain;
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatchObject({ kind: "input", threadId });
        expect(
          (yield* h.sql<{
            identity: string;
          }>`SELECT identity FROM web_push_deliveries WHERE status = 'sent'`)[0]?.identity,
        ).toContain(":input:secret-item");
      }),
    ),
  );
  it.effect("notifies when a PR watch releases completion, including across replay pages", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        h.setShell({ pullRequests: [watchedPr] });
        yield* h.metadata("thread.pull-request-synced");
        yield* h.event({
          latestRunId: RunId.make("new"),
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
        });
        yield* TestClock.adjust("6 minutes");
        yield* h.metadata("thread.metadata-updated", 201);
        h.setShell({ pendingBackgroundTasks: [], pullRequests: [] });
        yield* h.metadata("thread.pull-request-synced");
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]?.kind).toBe("completion");
      }),
    ),
  );
  it.effect(
    "checks each delivery deadline and reduces provider TTL to the remaining lifetime",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness;
          yield* h.register();
          yield* h.service.register(owner, {
            deviceId: "22222222-2222-4222-8222-222222222222",
            origin: "https://app.example",
            subscription: { ...subscription, endpoint: subscription.endpoint + "secondary" },
          });
          yield* h.event({ latestRunId: RunId.make("new") });
          yield* TestClock.adjust("1 minute");
          h.setOnSend(() => TestClock.adjust("5 minutes"));
          yield* h.service.drain;
          expect(h.sent).toHaveLength(1);
          expect(h.ttls).toEqual([240]);
          expect(
            yield* h.sql<{
              status: string;
            }>`SELECT status FROM web_push_deliveries WHERE identity LIKE '%completion:new' AND status = 'expired'`,
          ).toHaveLength(1);
        }),
      ),
  );
  it.effect("lets Disable cancel another device before the remaining batch is sent", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        const otherDevice = "22222222-2222-4222-8222-222222222222";
        yield* h.service.register(owner, {
          deviceId: otherDevice,
          origin: "https://app.example",
          subscription: { ...subscription, endpoint: subscription.endpoint + "secondary" },
        });
        yield* h.event({ latestRunId: RunId.make("new") });
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        h.setOnSend(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        );
        const sending = yield* h.service.drain.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const disabling = yield* h.service.unregister(owner, otherDevice).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(disabling);
        yield* Fiber.join(sending);
        expect(h.sent).toHaveLength(1);
      }),
    ),
  );
  it.effect("retries durably but cancels an input resolved before retry", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        h.setResponse(503);
        yield* h.event({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "user_input",
            createdAt: yield* DateTime.now,
          },
        });
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
        yield* h.event({ pendingRuntimeRequest: null, status: "running" });
        yield* TestClock.adjust("3 seconds");
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
        expect(
          (yield* h.sql<{
            status: string;
          }>`SELECT status FROM web_push_deliveries WHERE identity LIKE '%input%'`)[0]?.status,
        ).toBe("cancelled");
      }),
    ),
  );
  it.effect("drops expired endpoints and never sends after session revocation", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        h.setResponse(410);
        yield* h.event({ latestRunId: RunId.make("new") });
        yield* h.service.drain;
        expect(yield* h.service.getDevice(owner, deviceId)).toEqual({ enabled: false });
        h.setResponse(201);
        yield* h.register();
        yield* h.sql`UPDATE auth_sessions SET revoked_at = '2026-01-01T00:00:00Z' WHERE session_id = ${owner}`;
        yield* h.event({ latestRunId: RunId.make("next") });
        yield* h.service.drain;
        expect(h.sent).toHaveLength(1);
      }),
    ),
  );
  it.effect("does not replay expired work or notify archived/subagent threads", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        yield* h.event(
          { latestRunId: RunId.make("new") },
          DateTime.subtract(yield* DateTime.now, { minutes: 6 }),
        );
        yield* h.service.drain;
        yield* h.event({ archivedAt: yield* DateTime.now });
        yield* h.service.drain;
        yield* h.event({
          archivedAt: null,
          lineage: {
            rootThreadId: threadId,
            parentThreadId: threadId,
            relationshipToParent: "subagent",
          },
        });
        yield* h.service.drain;
        expect(h.sent).toHaveLength(0);
      }),
    ),
  );
  it.effect("isolates owners and permits matching-subscription repair after re-pairing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.register();
        const other = AuthSessionId.make("other");
        expect((yield* h.service.unregister(other, deviceId).pipe(Effect.flip)).reason).toBe(
          "ownership",
        );
        expect(
          (yield* h.service
            .register(other, { deviceId, origin: "https://app.example", subscription })
            .pipe(Effect.flip)).reason,
        ).toBe("ownership");
        yield* h.sql`UPDATE auth_sessions SET revoked_at = '2026-01-01T00:00:00Z' WHERE session_id = ${owner}`;
        expect(
          yield* h.service.register(other, {
            deviceId,
            origin: "https://app.example",
            subscription,
          }),
        ).toEqual({ enabled: true });
        yield* h.service.unregister(other, deviceId);
        expect((yield* h.sql`SELECT * FROM web_push_devices`).length).toBe(0);
      }),
    ),
  );
});
