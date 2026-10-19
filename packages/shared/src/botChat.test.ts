import { expect, it } from "vite-plus/test";
import { isBotProject, botChatProviderDisabledReason, botCodexDisabledReason } from "./botChat.ts";

it.each(["0.158.0", "0.159.9", "0.160.0-alpha.1", null, "unknown"])(
  "blocks unverified or older Codex %s for memory",
  (version) => {
    expect(botCodexDisabledReason(version)).toContain("0.160.0");
  },
);
it.each(["0.160.0", "0.163.0", "codex-cli 0.163.0", "1.0.0"])(
  "allows supported Codex %s for memory",
  (version) => {
    expect(botChatProviderDisabledReason({ driver: "codex", version })).toBeNull();
  },
);
it("keeps other supported memory providers independent of Codex's version", () => {
  expect(botChatProviderDisabledReason({ driver: "pi", version: null })).toBeNull();
  expect(botChatProviderDisabledReason({ driver: "claudeAgent", version: null })).toBeNull();
});

it.each([
  [{ id: "memory", isBot: true }, true],
  [{ id: "one-chat:workspace" }, false],
  [{ id: "agent:8665b26d-7e56-464f-b935-4a909fe2eaed:workspace" }, false],
  [{ id: "ordinary" }, false],
  [{ id: "agent:ordinary:workspace" }, false],
])("recognizes bot project %j", (project, expected) => {
  expect(isBotProject(project)).toBe(expected);
});

it.each(["opencode", "cursor", "grok", "antigravity", "muse"])(
  "rejects %s for bot chat",
  (driver) => {
    expect(botChatProviderDisabledReason({ driver, version: "1.18.33" })).toBe(
      "This provider does not support bot chat.",
    );
  },
);
