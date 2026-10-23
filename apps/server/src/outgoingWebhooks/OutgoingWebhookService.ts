/**
 * Webhook configuration for this environment, used by the Settings UI over
 * RPC and by agents over MCP. Header values and secret endpoint URLs go
 * straight to the secret store and are never returned; a read shows the
 * header names and, for a secret endpoint, only its origin. An endpoint the
 * user did not mark secret is ordinary configuration and is returned whole.
 */
import {
  OutgoingWebhookError,
  OutgoingWebhookId,
  ThreadId,
  type OutgoingWebhook,
  type OutgoingWebhookDelivery,
  type OutgoingWebhookDeleteInput,
  type OutgoingWebhookListDeliveriesInput,
  type OutgoingWebhookListDeliveriesResult,
  type OutgoingWebhookListResult,
  type OutgoingWebhookMutationResult,
  type OutgoingWebhookSecretInput,
  type OutgoingWebhookTestInput,
  type OutgoingWebhookUpsertInput,
  type ProjectId,
} from "@satslab/contracts";
import {
  describeOutgoingWebhookTemplateError,
  isValidOutgoingWebhookHeaderValue,
  parseOutgoingWebhookClientBaseUrl,
  parseOutgoingWebhookEndpoint,
  parseOutgoingWebhookTemplate,
  OUTGOING_WEBHOOK_SAMPLE_CONTEXT,
} from "@satslab/shared/outgoingWebhook";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Delivery from "./OutgoingWebhookDelivery.ts";
import {
  OutgoingWebhookRepository,
  type StoredOutgoingWebhook,
} from "./OutgoingWebhookRepository.ts";
import { endpointSecretName, headerSecretName } from "./OutgoingWebhookSecrets.ts";

const DEFAULT_HISTORY_LIMIT = 20;

export interface OutgoingWebhookWriteOptions {
  /** Where a `secretRef` was requested; a ref is only redeemable inside that project. */
  readonly secretRefProjectId?: ProjectId;
}

const toWebhook = (stored: StoredOutgoingWebhook): OutgoingWebhook => ({
  id: stored.id,
  name: stored.name,
  enabled: stored.enabled,
  events: stored.events,
  template: stored.template,
  previewLength: stored.previewLength,
  clientBaseUrl: stored.clientBaseUrl,
  endpointOrigin: stored.endpointOrigin,
  secretEndpoint: stored.endpointUrl === null,
  endpointUrl: stored.endpointUrl,
  headerNames: stored.headerNames,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt,
});

export class OutgoingWebhookService extends Context.Service<
  OutgoingWebhookService,
  {
    readonly list: () => Effect.Effect<OutgoingWebhookListResult, OutgoingWebhookError>;
    readonly subscribeList: () => Stream.Stream<OutgoingWebhookListResult, OutgoingWebhookError>;
    readonly upsert: (
      input: OutgoingWebhookUpsertInput,
      options?: OutgoingWebhookWriteOptions,
    ) => Effect.Effect<OutgoingWebhookMutationResult, OutgoingWebhookError>;
    readonly delete: (
      input: OutgoingWebhookDeleteInput,
    ) => Effect.Effect<{ readonly deleted: boolean }, OutgoingWebhookError>;
    /** One attempt with sample content, outside the retry queue. */
    readonly test: (
      input: OutgoingWebhookTestInput,
    ) => Effect.Effect<{ readonly delivery: OutgoingWebhookDelivery }, OutgoingWebhookError>;
    readonly listDeliveries: (
      input: OutgoingWebhookListDeliveriesInput,
    ) => Effect.Effect<OutgoingWebhookListDeliveriesResult, OutgoingWebhookError>;
  }
>()("@satslab/sora/outgoingWebhooks/OutgoingWebhookService") {}

const make = Effect.gen(function* () {
  const repository = yield* OutgoingWebhookRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const delivery = yield* Delivery.OutgoingWebhookDelivery;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const fail = (message: string, webhookId?: OutgoingWebhookId, cause?: unknown) =>
    new OutgoingWebhookError({
      message,
      ...(webhookId === undefined ? {} : { webhookId }),
      ...(cause === undefined ? {} : { cause }),
    });
  const storageFailure = (cause: unknown) =>
    fail("Could not read or write webhook storage.", undefined, cause);

  const list: OutgoingWebhookService["Service"]["list"] = Effect.fn("OutgoingWebhookService.list")(
    function* () {
      const webhooks = yield* repository.list().pipe(Effect.mapError(storageFailure));
      return { webhooks: webhooks.map(toWebhook) };
    },
  );

  const subscribeList: OutgoingWebhookService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change between the two is buffered, not dropped.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  /** Turns an input secret into its value; a ref is consumed, so this runs last. */
  const resolveSecret = Effect.fn("OutgoingWebhookService.resolveSecret")(function* (
    secret: OutgoingWebhookSecretInput,
    options: OutgoingWebhookWriteOptions | undefined,
  ) {
    if ("value" in secret) return secret.value;
    if (options?.secretRefProjectId === undefined) {
      return yield* fail("A secretRef can only be redeemed by an agent that requested it.");
    }
    return yield* secretRequests
      .consume({ ref: secret.secretRef, projectId: options.secretRefProjectId })
      .pipe(Effect.mapError((error) => fail(error.message, undefined, error)));
  });

  const setSecret = (name: string, value: string) =>
    secrets
      .set(name, new TextEncoder().encode(value))
      .pipe(
        Effect.mapError((cause) => fail("Could not store a webhook secret.", undefined, cause)),
      );
  const removeSecret = (name: string) =>
    secrets
      .remove(name)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a webhook secret", { errorTag: error._tag }),
        ),
      );

  const readStoredEndpoint = Effect.fn("OutgoingWebhookService.readStoredEndpoint")(function* (
    id: OutgoingWebhookId,
  ) {
    const stored = yield* secrets
      .get(endpointSecretName(id))
      .pipe(Effect.mapError((cause) => fail("Could not read the stored endpoint.", id, cause)));
    if (Option.isNone(stored)) {
      return yield* fail("The stored endpoint is missing. Enter the URL again.", id);
    }
    return new TextDecoder().decode(stored.value);
  });

  const upsert: OutgoingWebhookService["Service"]["upsert"] = Effect.fn(
    "OutgoingWebhookService.upsert",
  )(function* (input, options) {
    const existing =
      input.id === undefined
        ? null
        : yield* repository.get(input.id).pipe(Effect.mapError(storageFailure));
    if (input.id !== undefined && existing === null) {
      return yield* fail("That webhook no longer exists.", input.id);
    }

    // Everything that can be checked without redeeming a ref goes first, since a ref works once.
    const template = parseOutgoingWebhookTemplate(input.template);
    if (!template.ok) return yield* fail(describeOutgoingWebhookTemplateError(template.error));
    if (
      input.clientBaseUrl !== null &&
      parseOutgoingWebhookClientBaseUrl(input.clientBaseUrl) === null
    ) {
      return yield* fail("The client URL must be an http or https address.");
    }
    // Omitting headers keeps what is stored, so an edit that never mentions them cannot drop one.
    const headers =
      input.headers ?? existing?.headerNames.map((name) => ({ name, value: undefined })) ?? [];
    const headerKeys = new Set<string>();
    for (const header of headers) {
      const key = header.name.toLowerCase();
      if (headerKeys.has(key)) return yield* fail(`Header ${header.name} is listed twice.`);
      headerKeys.add(key);
      const stored = existing?.headerNames.some((name) => name.toLowerCase() === key) === true;
      if (header.value === undefined && !stored) {
        return yield* fail(`Header ${header.name} needs a value.`);
      }
    }
    if (input.endpoint === undefined && existing === null) {
      return yield* fail("A new webhook needs an endpoint URL.");
    }
    // The choice is the user's, never inferred from the URL. Omitted, an existing webhook keeps
    // it; a new one is ordinary, except that a ref came from the private entry card.
    const sentRef = input.endpoint !== undefined && "secretRef" in input.endpoint;
    const secretEndpoint =
      input.secretEndpoint ?? (existing === null ? sentRef : existing.endpointUrl === null);
    if (sentRef && !secretEndpoint) {
      return yield* fail("A secretRef is for a secret endpoint. Mark the endpoint secret.");
    }
    // Switching the choice without a new URL carries the stored one across. Read it before
    // anything is written, so a missing secret fails the request whole.
    const switching = existing !== null && secretEndpoint !== (existing.endpointUrl === null);
    const carriedEndpoint =
      input.endpoint !== undefined || existing === null || !switching
        ? null
        : (existing.endpointUrl ?? (yield* readStoredEndpoint(existing.id)));

    const endpointValue =
      input.endpoint === undefined
        ? carriedEndpoint
        : yield* resolveSecret(input.endpoint, options);
    const endpoint = endpointValue === null ? null : parseOutgoingWebhookEndpoint(endpointValue);
    if (endpointValue !== null && endpoint === null) {
      return yield* fail("The endpoint must be an http or https URL.");
    }
    const headerValues: Array<readonly [name: string, value: string]> = [];
    for (const header of headers) {
      if (header.value === undefined) continue;
      const value = yield* resolveSecret(header.value, options);
      if (!isValidOutgoingWebhookHeaderValue(value)) {
        return yield* fail(`The value for header ${header.name} contains invalid characters.`);
      }
      headerValues.push([header.name, value]);
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const id =
      existing?.id ??
      OutgoingWebhookId.make(
        `owh_${yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => fail("Could not create a webhook id.", undefined, cause)))}`,
      );
    const stored: StoredOutgoingWebhook = {
      id,
      name: input.name,
      enabled: input.enabled,
      enabledSince:
        input.enabled && existing?.enabled !== true ? now : (existing?.enabledSince ?? null),
      events: input.events,
      template: input.template,
      previewLength: input.previewLength,
      clientBaseUrl: input.clientBaseUrl,
      endpointOrigin: endpoint?.origin ?? existing?.endpointOrigin ?? "",
      endpointUrl: secretEndpoint ? null : (endpointValue ?? existing?.endpointUrl ?? null),
      headerNames: headers.map((header) => header.name),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (secretEndpoint && endpointValue !== null) {
      yield* setSecret(endpointSecretName(id), endpointValue);
    }
    for (const [name, value] of headerValues) yield* setSecret(headerSecretName(id, name), value);
    yield* repository.save(stored).pipe(
      Effect.mapError(storageFailure),
      Effect.tapError(() =>
        existing === null
          ? Effect.forEach(
              [endpointSecretName(id), ...headerValues.map(([name]) => headerSecretName(id, name))],
              removeSecret,
              { discard: true },
            )
          : // An existing webhook keeps the values it had, except a new secret that was never live.
            switching && secretEndpoint
            ? removeSecret(endpointSecretName(id))
            : Effect.void,
      ),
    );
    // A nonsecret endpoint lives in the row, so any secret left from before is stale.
    if (!secretEndpoint && existing !== null) yield* removeSecret(endpointSecretName(id));
    const kept = new Set(stored.headerNames.map((name) => name.toLowerCase()));
    yield* Effect.forEach(
      (existing?.headerNames ?? []).filter((name) => !kept.has(name.toLowerCase())),
      (name) => removeSecret(headerSecretName(id, name)),
      { discard: true },
    );
    // Turning a webhook off drops what it had queued, so nothing sends after the user said stop.
    if (!stored.enabled)
      yield* repository.cancelPending(id, now).pipe(Effect.mapError(storageFailure));
    yield* notifyChanged;
    return { webhook: toWebhook(stored) };
  });

  const deleteWebhook: OutgoingWebhookService["Service"]["delete"] = Effect.fn(
    "OutgoingWebhookService.delete",
  )(function* (input) {
    const existing = yield* repository.get(input.id).pipe(Effect.mapError(storageFailure));
    if (existing === null) return { deleted: false };
    yield* repository.remove(input.id).pipe(Effect.mapError(storageFailure));
    yield* Effect.forEach(
      [
        endpointSecretName(input.id),
        ...existing.headerNames.map((name) => headerSecretName(input.id, name)),
      ],
      removeSecret,
      { discard: true },
    );
    yield* notifyChanged;
    return { deleted: true };
  });

  const test: OutgoingWebhookService["Service"]["test"] = Effect.fn("OutgoingWebhookService.test")(
    function* (input) {
      const webhook = yield* repository.get(input.id).pipe(Effect.mapError(storageFailure));
      if (webhook === null) return yield* fail("That webhook no longer exists.", input.id);
      const now = DateTime.formatIso(yield* DateTime.now);
      const jobId = `whd_test_${yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => fail("Could not create a test id.", input.id, cause)))}`;
      const context = {
        threadId: ThreadId.make(OUTGOING_WEBHOOK_SAMPLE_CONTEXT.thread.id),
        threadTitle: OUTGOING_WEBHOOK_SAMPLE_CONTEXT.thread.title,
        preview: OUTGOING_WEBHOOK_SAMPLE_CONTEXT.message.preview,
        template: webhook.template,
        clientBaseUrl: webhook.clientBaseUrl,
      };
      yield* repository
        .insertSending({ id: jobId, webhookId: webhook.id, eventType: "test", context, now })
        .pipe(Effect.mapError(storageFailure));
      yield* delivery.attemptOnce({
        id: jobId,
        webhookId: webhook.id,
        eventType: "test",
        context,
        attempts: 1,
      });
      const result = yield* repository.job(jobId).pipe(Effect.mapError(storageFailure));
      if (result === null) return yield* fail("That webhook no longer exists.", input.id);
      return { delivery: result };
    },
  );

  const listDeliveries: OutgoingWebhookService["Service"]["listDeliveries"] = Effect.fn(
    "OutgoingWebhookService.listDeliveries",
  )(function* (input) {
    const deliveries = yield* repository
      .history(input.webhookId, input.limit ?? DEFAULT_HISTORY_LIMIT)
      .pipe(Effect.mapError(storageFailure));
    return { deliveries };
  });

  return OutgoingWebhookService.of({
    list,
    subscribeList,
    upsert,
    delete: deleteWebhook,
    test,
    listDeliveries,
  });
});

export const layer = Layer.effect(OutgoingWebhookService, make);
