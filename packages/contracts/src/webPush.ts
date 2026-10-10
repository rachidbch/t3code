import * as Schema from "effect/Schema";

export class WebPushError extends Schema.TaggedError<WebPushError>()("WebPushError", {
  reason: Schema.Literals(["invalid", "ownership", "unauthorized", "storage", "delivery"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return "The Web Push operation could not be completed.";
  }
}
export const WebPushDeviceInput = Schema.Struct({
  deviceId: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
});
export const WebPushSubscription = Schema.Struct({
  endpoint: Schema.String.check(Schema.isMaxLength(4096)),
  keys: Schema.Struct({
    p256dh: Schema.String.check(Schema.isMaxLength(128)),
    auth: Schema.String.check(Schema.isMaxLength(64)),
  }),
});
export const WebPushRegisterInput = Schema.Struct({
  ...WebPushDeviceInput.fields,
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  subscription: WebPushSubscription,
});
export type WebPushRegisterInput = typeof WebPushRegisterInput.Type;
export const WebPushDeviceResult = Schema.Struct({ enabled: Schema.Boolean });
export const WebPushConfig = Schema.Struct({ publicKey: Schema.String });
export const WebPushPayload = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["completion", "input", "approval", "failed", "test"]),
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  tag: Schema.String,
});
export type WebPushPayload = typeof WebPushPayload.Type;
