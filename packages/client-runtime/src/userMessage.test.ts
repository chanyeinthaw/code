import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessagePresentation } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const discordInput = {
    source: "discord",
    routeId: "bot:100",
    guildId: "30",
    channelId: "20",
    messageId: "100",
    sender: { id: "40", displayName: "Chan" },
    text: "Who are you?",
    attachments: [],
  };
  const discordText = `Discord routing instructions.\n\n${JSON.stringify(discordInput)}`;

  it("folds Discord input as an agent-style message with the sender and actual message", () => {
    expect(
      resolveUserMessagePresentation({
        id: "bot-input:bot:100",
        role: "user",
        createdBy: "user",
        creationSource: "server",
        text: discordText,
      }),
    ).toEqual({
      text: "Who are you?",
      attribution: "agent",
      sourceLabel: "Discord · Chan",
      scheduledTaskId: undefined,
    });
  });

  it("keeps ordinary user text and malformed integration input intact", () => {
    for (const patch of [
      { id: "user-message", creationSource: "web" as const, text: discordText },
      {
        id: "bot-input:bot:100",
        creationSource: "server" as const,
        text: "Not a Discord envelope",
      },
      {
        id: "bot-input:bot:100",
        creationSource: "server" as const,
        text: `Instructions\n\n${JSON.stringify({ ...discordInput, source: "unknown" })}`,
      },
    ]) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "user", ...patch }),
      ).toMatchObject({ text: patch.text, attribution: null });
    }
  });

  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("attributes older server-sent restart continuations to Sora, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "sora" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
