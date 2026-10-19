import { expect, it } from "vite-plus/test";
import { memoryChatProviderDisabledReason, memoryCodexDisabledReason } from "./memoryChat.ts";

it.each(["0.158.0", "0.159.9", "0.160.0-alpha.1", null, "unknown"])(
  "blocks unverified or older Codex %s for memory",
  (version) => {
    expect(memoryCodexDisabledReason(version)).toContain("0.160.0");
  },
);
it.each(["0.160.0", "0.163.0", "codex-cli 0.163.0", "1.0.0"])(
  "allows supported Codex %s for memory",
  (version) => {
    expect(memoryChatProviderDisabledReason({ driver: "codex", version })).toBeNull();
  },
);
it("keeps other supported memory providers independent of Codex's version", () => {
  expect(memoryChatProviderDisabledReason({ driver: "pi", version: null })).toBeNull();
  expect(memoryChatProviderDisabledReason({ driver: "claudeAgent", version: null })).toBeNull();
});
