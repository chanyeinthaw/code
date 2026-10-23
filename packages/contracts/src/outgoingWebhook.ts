import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  OutgoingWebhookId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Thread events a webhook can subscribe to. They follow what the mobile activity awareness reports. */
export const OUTGOING_WEBHOOK_EVENT_TYPES = [
  "completed",
  "failed",
  "approval_required",
  "input_required",
] as const;
export const OutgoingWebhookEventType = Schema.Literals(OUTGOING_WEBHOOK_EVENT_TYPES);
export type OutgoingWebhookEventType = typeof OutgoingWebhookEventType.Type;

/** `test` is only produced by the explicit Test action; it is not a subscribable event. */
export const OutgoingWebhookDeliveryEventType = Schema.Literals([
  ...OUTGOING_WEBHOOK_EVENT_TYPES,
  "test",
]);
export type OutgoingWebhookDeliveryEventType = typeof OutgoingWebhookDeliveryEventType.Type;

/** Variables a template may reference as `{{name}}` inside a JSON string value. */
export const OUTGOING_WEBHOOK_TEMPLATE_VARIABLES = [
  "thread.id",
  "thread.title",
  "thread.url",
  "thread.soraUrl",
  "thread.t3codeUrl",
  "message.preview",
  "event.type",
  "event.emoji",
] as const;
export type OutgoingWebhookTemplateVariable = (typeof OUTGOING_WEBHOOK_TEMPLATE_VARIABLES)[number];

export const DEFAULT_OUTGOING_WEBHOOK_TEMPLATE =
  '{"title":"{{thread.title}}","body":"{{message.preview}}","url":"{{thread.url}}"}';
export const DEFAULT_OUTGOING_WEBHOOK_PREVIEW_LENGTH = 500;
export const MAX_OUTGOING_WEBHOOK_PREVIEW_LENGTH = 4000;
const MAX_OUTGOING_WEBHOOK_TEMPLATE_LENGTH = 8000;
/** A rendered body larger than this is not sent; the delivery fails as `payload_too_large`. */
export const MAX_OUTGOING_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_OUTGOING_WEBHOOK_HEADERS = 10;
export const MAX_OUTGOING_WEBHOOK_SECRET_LENGTH = 4096;

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** The delivery worker owns these; configuring them would break framing or idempotency. */
const RESERVED_OUTGOING_WEBHOOK_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "host",
  "idempotency-key",
  "transfer-encoding",
]);

const OutgoingWebhookName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const OutgoingWebhookHeaderName = Schema.String.check(
  Schema.isMaxLength(100),
  Schema.isPattern(HEADER_NAME_PATTERN),
  Schema.makeFilter((name: string) => !RESERVED_OUTGOING_WEBHOOK_HEADERS.has(name.toLowerCase()), {
    expected: "a header name this app does not set itself",
  }),
);
const OutgoingWebhookSecretValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_OUTGOING_WEBHOOK_SECRET_LENGTH),
);

/**
 * An endpoint URL or header value. A header value, and an endpoint marked
 * secret, are kept in the server secret store and never returned. `secretRef` is a one-use handle from `request_secret`.
 */
export const OutgoingWebhookSecretInput = Schema.Union([
  Schema.Struct({ value: OutgoingWebhookSecretValue }),
  Schema.Struct({ secretRef: SecretRef }),
]);
export type OutgoingWebhookSecretInput = typeof OutgoingWebhookSecretInput.Type;

/** A header value an agent may send: a ref only, so a credential never passes through the model. */
const OutgoingWebhookSecretRefInput = Schema.Struct({ secretRef: SecretRef });

const OutgoingWebhookConfigFields = {
  name: OutgoingWebhookName,
  enabled: Schema.Boolean,
  events: Schema.Array(OutgoingWebhookEventType).check(Schema.isMinLength(1)),
  template: Schema.String.check(Schema.isMaxLength(MAX_OUTGOING_WEBHOOK_TEMPLATE_LENGTH)),
  previewLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_OUTGOING_WEBHOOK_PREVIEW_LENGTH }),
  ),
  /** Where `thread.url` points, such as the address you open Sora at. Null leaves the variable empty. */
  clientBaseUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
};

/**
 * Header values are never returned. A secret endpoint shows only its origin;
 * otherwise the endpoint is ordinary configuration and `endpointUrl` is its
 * full URL, so it can be read and edited.
 */
export const OutgoingWebhook = Schema.Struct({
  id: OutgoingWebhookId,
  ...OutgoingWebhookConfigFields,
  endpointOrigin: Schema.String,
  secretEndpoint: Schema.Boolean,
  endpointUrl: Schema.NullOr(Schema.String),
  headerNames: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OutgoingWebhook = typeof OutgoingWebhook.Type;

/**
 * `endpoint` is required when creating. `secretEndpoint` chooses whether the
 * endpoint is kept secret or as ordinary readable configuration; omitted, an
 * existing webhook keeps its choice, and a new one is ordinary unless its
 * endpoint is a `secretRef`. Changing it without a new `endpoint` moves the
 * stored URL across. A header named in `headers` without a
 * value keeps its stored value. When `headers` is given, a stored header left
 * out of it is removed; when it is omitted, stored headers are kept (a new
 * webhook then has none).
 */
const upsertInput = <Endpoint extends Schema.Top, HeaderValue extends Schema.Top>(fields: {
  readonly endpoint: Endpoint;
  readonly headerValue: HeaderValue;
}) =>
  Schema.Struct({
    id: Schema.optional(OutgoingWebhookId),
    ...OutgoingWebhookConfigFields,
    endpoint: Schema.optional(fields.endpoint),
    secretEndpoint: Schema.optional(Schema.Boolean),
    headers: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: OutgoingWebhookHeaderName,
          value: Schema.optional(fields.headerValue),
        }),
      ).check(Schema.isMaxLength(MAX_OUTGOING_WEBHOOK_HEADERS)),
    ),
  });
export const OutgoingWebhookUpsertInput = upsertInput({
  endpoint: OutgoingWebhookSecretInput,
  headerValue: OutgoingWebhookSecretInput,
});
export type OutgoingWebhookUpsertInput = typeof OutgoingWebhookUpsertInput.Type;

/**
 * What an agent may send. The endpoint is a URL the user already gave the
 * agent, whose path or query may carry the credential, or a `secretRef` from
 * `request_secret`. Header values stay `secretRef`s. Assignable to
 * `OutgoingWebhookUpsertInput`.
 */
export const OutgoingWebhookAgentUpsertInput = upsertInput({
  endpoint: OutgoingWebhookSecretInput,
  headerValue: OutgoingWebhookSecretRefInput,
});
export type OutgoingWebhookAgentUpsertInput = typeof OutgoingWebhookAgentUpsertInput.Type;

export const OutgoingWebhookListInput = Schema.Struct({});
export const OutgoingWebhookListResult = Schema.Struct({
  webhooks: Schema.Array(OutgoingWebhook),
});
export type OutgoingWebhookListResult = typeof OutgoingWebhookListResult.Type;

export const OutgoingWebhookMutationResult = Schema.Struct({ webhook: OutgoingWebhook });
export type OutgoingWebhookMutationResult = typeof OutgoingWebhookMutationResult.Type;

export const OutgoingWebhookDeleteInput = Schema.Struct({ id: OutgoingWebhookId });
export type OutgoingWebhookDeleteInput = typeof OutgoingWebhookDeleteInput.Type;
export const OutgoingWebhookDeleteResult = Schema.Struct({ deleted: Schema.Boolean });

export const OutgoingWebhookTestInput = Schema.Struct({ id: OutgoingWebhookId });
export type OutgoingWebhookTestInput = typeof OutgoingWebhookTestInput.Type;

/** A sanitized category; the raw error and the response body are never stored. */
export const OutgoingWebhookFailureCategory = Schema.Literals([
  "network",
  "timeout",
  "rate_limited",
  "server_error",
  "rejected",
  "secret_missing",
  "template_invalid",
  "payload_too_large",
]);
export type OutgoingWebhookFailureCategory = typeof OutgoingWebhookFailureCategory.Type;

export const OutgoingWebhookDeliveryStatus = Schema.Literals([
  "queued",
  "sending",
  "succeeded",
  "failed",
  "cancelled",
]);
export type OutgoingWebhookDeliveryStatus = typeof OutgoingWebhookDeliveryStatus.Type;

export const OutgoingWebhookDelivery = Schema.Struct({
  id: Schema.String,
  webhookId: OutgoingWebhookId,
  eventType: OutgoingWebhookDeliveryEventType,
  threadId: Schema.NullOr(ThreadId),
  status: OutgoingWebhookDeliveryStatus,
  attempts: Schema.Int,
  httpStatus: Schema.NullOr(Schema.Int),
  failure: Schema.NullOr(OutgoingWebhookFailureCategory),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OutgoingWebhookDelivery = typeof OutgoingWebhookDelivery.Type;

export const OutgoingWebhookListDeliveriesInput = Schema.Struct({
  webhookId: OutgoingWebhookId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OutgoingWebhookListDeliveriesInput = typeof OutgoingWebhookListDeliveriesInput.Type;
export const OutgoingWebhookListDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(OutgoingWebhookDelivery),
});
export type OutgoingWebhookListDeliveriesResult = typeof OutgoingWebhookListDeliveriesResult.Type;
export const OutgoingWebhookTestResult = Schema.Struct({ delivery: OutgoingWebhookDelivery });
export type OutgoingWebhookTestResult = typeof OutgoingWebhookTestResult.Type;

export class OutgoingWebhookError extends Schema.TaggedError<OutgoingWebhookError>()(
  "OutgoingWebhookError",
  {
    message: Schema.String,
    webhookId: Schema.optional(OutgoingWebhookId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
