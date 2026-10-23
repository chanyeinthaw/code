import {
  OrchestratorMcpFailure,
  OutgoingWebhook,
  OutgoingWebhookDeleteInput,
  OutgoingWebhookDeleteResult,
  OutgoingWebhookAgentUpsertInput,
} from "@satslab/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OutgoingWebhookService from "../../../outgoingWebhooks/OutgoingWebhookService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    OutgoingWebhookService.OutgoingWebhookService,
  ],
};

const OutgoingWebhooksListTool = Tool.make("s3_outgoing_webhooks_list", {
  ...shared,
  description:
    "List this environment's outgoing webhooks. An endpoint marked secret shows only its origin (secretEndpoint true); any other endpoint is returned whole as endpointUrl. Headers show only names; their values are never returned.",
  success: Schema.Struct({ webhooks: Schema.Array(OutgoingWebhook) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const OutgoingWebhooksUpsertTool = Tool.make("s3_outgoing_webhooks_upsert", {
  ...shared,
  description:
    "Create (omit id) or update an outgoing webhook in this environment. Sora posts JSON to it when a thread completes, fails, needs approval or needs input; the agent cannot send on its own. The template is JSON whose string values may use {{thread.id}}, {{thread.title}}, {{thread.url}}, {{thread.soraUrl}}, {{thread.t3codeUrl}}, {{message.preview}}, {{event.type}} and {{event.emoji}}; event.emoji is ✅ for completed, ❌ for failed, ✋ for approval_required, 💬 for input_required and 🧪 for a test delivery. For example, use {{event.emoji}} {{thread.title}} in a title string; {{thread.url}} stays empty until clientBaseUrl names the address the user opens Sora at, while soraUrl and t3codeUrl open the desktop or mobile app and need no clientBaseUrl. The endpoint is { value: url } or { secretRef }. When the user already gave you the URL, pass it as the endpoint value; do not invent, extract or guess a URL or credential. secretEndpoint chooses how the URL is kept: false stores it as ordinary configuration that list returns whole as endpointUrl, true keeps it in the secret store and list shows only its origin. Never infer it from the URL; if the user has not said, leave it out (new webhooks default to false, a secretRef endpoint to true, and updates keep the current choice) and offer to mark it secret if it carries a credential. Changing secretEndpoint without an endpoint moves the stored URL across, and setting it to false reveals that URL in list, so only do so when the user asks. If the URL is missing, or the user wants to enter it privately, call request_secret and pass the secretRef (secret endpoints only). Do not repeat the endpoint URL in your reply. Header values (only when the destination needs separate authentication, such as Authorization) must be secretRefs from request_secret; never ask for a secret in chat. Omit headers for a webhook that needs none. On update, omit endpoint to keep the stored one; omit headers to keep stored headers, or list them to replace the set (a stored header left out is removed, and one named without a value keeps its value). Needs a live full-access/default calling thread or a full-access client; secretRefs need a calling thread.",
  parameters: OutgoingWebhookAgentUpsertInput,
  success: Schema.Struct({ webhook: OutgoingWebhook }),
}).annotate(Tool.Destructive, true);

const OutgoingWebhooksDeleteTool = Tool.make("s3_outgoing_webhooks_delete", {
  ...shared,
  description:
    "Delete an outgoing webhook, its stored endpoint and header secrets, its queued deliveries and its history. Needs a live full-access/default calling thread or a full-access client.",
  parameters: OutgoingWebhookDeleteInput,
  success: OutgoingWebhookDeleteResult,
}).annotate(Tool.Destructive, true);

export const OutgoingWebhooksToolkit = Toolkit.make(
  OutgoingWebhooksListTool,
  OutgoingWebhooksUpsertTool,
  OutgoingWebhooksDeleteTool,
);
