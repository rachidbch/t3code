import webPush from "web-push";
import { WebPushError, type WebPushSubscription, WebPushPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class WebPushSender extends Context.Service<
  WebPushSender,
  {
    readonly getConfig: Effect.Effect<{ publicKey: string }, WebPushError>;
    readonly send: (
      subscription: typeof WebPushSubscription.Type,
      payload: WebPushPayload,
      ttlSeconds: number,
    ) => Effect.Effect<number, WebPushError>;
  }
>()("t3/webPush/WebPushSender") {}
const Keys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
const decodeKeys = Schema.decodeEffect(Schema.fromJsonString(Keys));
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Keys));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(WebPushPayload));
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const keys = lock.withPermits(1)(
    Effect.gen(function* () {
      const stored = yield* secrets.get("web-push-vapid");
      if (Option.isSome(stored)) return yield* decodeKeys(new TextDecoder().decode(stored.value));
      const generated = yield* Effect.sync(() => webPush.generateVAPIDKeys());
      const encoded = yield* encodeKeys(generated);
      yield* secrets.create("web-push-vapid", new TextEncoder().encode(encoded));
      return generated;
    }).pipe(Effect.mapError((cause) => new WebPushError({ reason: "storage", cause }))),
  );
  return WebPushSender.of({
    getConfig: keys.pipe(Effect.map(({ publicKey }) => ({ publicKey }))),
    send: Effect.fn("WebPushSender.send")(function* (subscription, payload, ttlSeconds) {
      const vapid = yield* keys;
      const encoded = yield* encodePayload(payload).pipe(
        Effect.mapError((cause) => new WebPushError({ reason: "delivery", cause })),
      );
      return yield* Effect.tryPromise({
        try: () =>
          webPush
            .sendNotification(subscription, encoded, {
              vapidDetails: { ...vapid, subject: "https://t3.codes" },
              TTL: ttlSeconds,
              timeout: 10_000,
            })
            .then((result) => result.statusCode)
            .catch((error: unknown) => {
              if (
                typeof error === "object" &&
                error !== null &&
                "statusCode" in error &&
                typeof error.statusCode === "number"
              )
                return error.statusCode;
              return 503;
            }),
        catch: (cause) => new WebPushError({ reason: "delivery", cause }),
      });
    }),
  });
});
export const layer = Layer.effect(WebPushSender, make);
