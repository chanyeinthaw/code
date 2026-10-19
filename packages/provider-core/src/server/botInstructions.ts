import type { McpProviderSessionConfig } from "./mcpSession.ts";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "./orchestrationInstructions.ts";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

export function buildBotSystemPrompt(input: {
  readonly botPrompt: string;
  readonly runtime: Parameters<typeof buildRuntimeInstructions>[0];
  readonly mcpSession: McpProviderSessionConfig | undefined;
}): string {
  return [
    input.mcpSession === undefined ? "" : T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    buildRuntimeInstructions(input.runtime),
    input.mcpSession?.browserToolsAvailable ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    input.mcpSession?.capabilities?.has("device") ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
    input.botPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}
