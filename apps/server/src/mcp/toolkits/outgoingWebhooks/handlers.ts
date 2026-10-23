import { OrchestratorMcpFailure, type OutgoingWebhookError } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as OutgoingWebhookService from "../../../outgoingWebhooks/OutgoingWebhookService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { OutgoingWebhooksToolkit } from "./tools.ts";

// The service's messages are fixed text and never contain a secret, so they are safe to show the model.
const invalidRequest = (error: OutgoingWebhookError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(OutgoingWebhooksToolkit, {
  s3_outgoing_webhooks_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const webhooks = yield* OutgoingWebhookService.OutgoingWebhookService;
      return yield* webhooks.list().pipe(Effect.mapError(unavailable));
    }),
  ),
  s3_outgoing_webhooks_upsert: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const webhooks = yield* OutgoingWebhookService.OutgoingWebhookService;
      // A ref only redeems inside the project of the thread it was requested in.
      const projectId = caller.caller?.projectId;
      return yield* webhooks
        .upsert(input, projectId === undefined ? undefined : { secretRefProjectId: projectId })
        .pipe(Effect.mapError(invalidRequest));
    }),
  ),
  s3_outgoing_webhooks_delete: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      yield* check;
      const webhooks = yield* OutgoingWebhookService.OutgoingWebhookService;
      return yield* webhooks.delete(input).pipe(Effect.mapError(invalidRequest));
    }),
  ),
});
