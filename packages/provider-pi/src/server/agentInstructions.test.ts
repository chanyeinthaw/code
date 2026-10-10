import { assert, it } from "@effect/vitest";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

it("appends configured instructions through Pi's system-prompt hook", async () => {
  const bridge = await loadMcpBridge({
    additionalInstructions: "User-configured agent instructions",
  });
  const prompt = await bridge.handlers.get("before_agent_start")!(
    { systemPrompt: "Pi built-in prompt" },
    { ui: { notify: () => undefined } },
  );
  assert.equal(prompt.systemPrompt.startsWith("Pi built-in prompt"), true);
  assert.include(prompt.systemPrompt, "orchestrator_capabilities");
  assert.equal(prompt.systemPrompt.endsWith("User-configured agent instructions"), true);
});
