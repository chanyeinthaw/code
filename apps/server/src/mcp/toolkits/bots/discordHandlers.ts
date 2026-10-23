import * as DiscordIntegration from "@satslab/bot-discord/DiscordIntegration";
import { BotConnectionTool } from "@satslab/bot-discord/DiscordTools";
import { Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const toolkit = Toolkit.make(
  BotConnectionTool.addDependency(McpInvocationContext.McpInvocationContext).addDependency(
    ThreadManagement.ThreadManagementService,
  ),
);

export const layer = McpToolAccess.toLayer(toolkit, {
  s3_bot_connection: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(invocation, "Bot connection");
      return yield* (yield* DiscordIntegration.DiscordIntegration).connection(
        caller.thread.threadId,
        input,
      );
    }),
  ),
});
