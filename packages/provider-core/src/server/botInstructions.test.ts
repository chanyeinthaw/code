import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@satslab/contracts";
import { buildBotSystemPrompt } from "./botInstructions.ts";

const runtime = { harness: "Pi", model: "provider/custom", reasoningEffort: "high" };
const session = {
  environmentId: EnvironmentId.make("owner"),
  threadId: ThreadId.make("memory"),
  providerInstanceId: ProviderInstanceId.make("custom-home"),
  providerSessionId: "session",
  endpoint: "http://localhost/bot-mcp",
  authorizationHeader: "Bearer test",
  browserToolsAvailable: false,
};

describe("memory provider instructions", () => {
  it("keeps recall and coordinator instructions after app guidance with runtime identity", () => {
    const prompt = buildBotSystemPrompt({
      botPrompt: "Frozen view. Delegate by default; act directly when explicitly asked.",
      runtime,
      mcpSession: session,
    });
    expect(prompt).toContain("provider/custom");
    expect(prompt).toContain("high reasoning effort");
    expect(prompt).toContain("orchestrator_capabilities");
    expect(prompt).toContain("link_pull_request");
    expect(prompt).toContain("html_render");
    expect(prompt.endsWith("act directly when explicitly asked.")).toBe(true);
    expect(prompt).not.toContain("## Sora collaborative browser");
    expect(prompt).not.toContain("## Sora devices");
  });

  it("adds browser and device guidance only when available", () => {
    const prompt = buildBotSystemPrompt({
      botPrompt: "Frozen view",
      runtime,
      mcpSession: { ...session, browserToolsAvailable: true, capabilities: new Set(["device"]) },
    });
    expect(prompt).toContain("## Sora collaborative browser");
    expect(prompt).toContain("## Sora devices");
  });

  it("preserves memory and runtime identity without claiming MCP orchestration is available", () => {
    const prompt = buildBotSystemPrompt({
      botPrompt: "Frozen view",
      runtime,
      mcpSession: undefined,
    });
    expect(prompt).toContain("Frozen view");
    expect(prompt).toContain("through the Pi harness");
    expect(prompt).not.toContain("## Sora orchestration");
  });
});
