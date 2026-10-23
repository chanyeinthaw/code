import { OrchestrationV2DomainEvent } from "./orchestrationV2.ts";
import { ApplicationProjectCreatedPayload } from "./applicationEvent.ts";
import { ThreadEnvMode } from "./environment.ts";
import { StoredProjectIcon } from "./project.ts";
import { ProjectSettingsOverrides } from "./settings.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, RunId, BotId } from "./baseSchemas.ts";

// These providers expose a built-in tool policy while preserving native MCP servers.
export const BOT_CHAT_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "pi",
]);

export const MemoryPart = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  count: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type MemoryPart = typeof MemoryPart.Type;
export const MemoryNode = Schema.Struct({ ...MemoryPart.fields, text: Schema.String });
export type MemoryNode = typeof MemoryNode.Type;
export const MemoryState = Schema.Struct({
  parts: Schema.Array(MemoryPart),
  pending: Schema.Boolean,
  revision: Schema.Int,
  compactParts: Schema.Array(MemoryPart),
  compactPending: Schema.Boolean,
  compactRevision: Schema.Int,
  total: Schema.Int,
  frontier: Schema.Int,
});
export type MemoryState = typeof MemoryState.Type;
export const BotIdentity = Schema.Struct({
  id: BotId,
  name: Schema.String,
  ownerEnvironmentId: EnvironmentId,
  threadId: ThreadId,
  generation: Schema.Int,
  status: Schema.Literals(["active", "transferring", "staged", "forwarded", "deleted"]),
  destinationEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type BotIdentity = typeof BotIdentity.Type;
export const BotDiscoveryInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type BotDiscoveryInput = typeof BotDiscoveryInput.Type;
export const BotDiscoveryResult = Schema.Struct({
  bots: Schema.Array(BotIdentity),
  nextCursor: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type BotDiscoveryResult = typeof BotDiscoveryResult.Type;

export const MemoryMessage = Schema.Struct({
  id: Schema.Int,
  key: Schema.String,
  kind: Schema.Literals(["user", "talk", "tool", "echo"]),
  text: Schema.String,
  date: Schema.String,
});
export type MemoryMessage = typeof MemoryMessage.Type;
export const MemoryJob = Schema.Struct({ ...MemoryPart.fields, source: Schema.String });
export type MemoryJob = typeof MemoryJob.Type;
export const MemorySnapshot = Schema.Struct({
  botId: BotId,
  runId: RunId,
  total: Schema.Int,
  view: Schema.String,
});
export type MemorySnapshot = typeof MemorySnapshot.Type;
export class BotChatError extends Schema.TaggedError<BotChatError>()("BotChatError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "storage",
    "not-found",
    "not-owner",
    "busy",
    "invalid-range",
    "not-ready",
    "inference",
    "invalid-transfer",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "Bot identity was not found.";
      case "not-owner":
        return "This environment does not own this bot.";
      case "busy":
        return "Bot has an active turn or ownership transfer.";
      case "invalid-range":
        return "Use an aligned power-of-two range within the frozen memory.";
      case "not-ready":
        return "Memory summaries are not ready. Your history is saved; retry the turn.";
      case "inference":
        return "Memory compaction failed. Your history is saved; retry the turn.";
      case "invalid-transfer":
        return "Bot transfer state or ownership proof is invalid.";
      case "storage":
        return "Bot storage operation failed.";
    }
  }
}
export const BotTransfer = Schema.Struct({
  transferId: Schema.String,
  releaseHash: Schema.String,
  identity: BotIdentity,
  destinationEnvironmentId: EnvironmentId,
  state: MemoryState,
  messages: Schema.Array(MemoryMessage),
  nodes: Schema.Array(MemoryNode),
  jobs: Schema.Array(MemoryJob),
  snapshots: Schema.Array(MemorySnapshot),
  events: Schema.Array(OrchestrationV2DomainEvent),
  project: Schema.Struct({
    defaultModelSelection: ApplicationProjectCreatedPayload.fields.defaultModelSelection,
    defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
    autoPull: Schema.Boolean,
    projectIcon: Schema.NullOr(StoredProjectIcon),
    scripts: ApplicationProjectCreatedPayload.fields.scripts,
    settingsOverrides: ProjectSettingsOverrides,
  }),
});
export type BotTransfer = typeof BotTransfer.Type;

/** A staged transfer is never authoritative while its source is still visible. */
export function selectBotIdentities(identities: readonly BotIdentity[]) {
  const selected = new Map<BotId, BotIdentity>();
  for (const bot of identities) {
    const previous = selected.get(bot.id);
    if (
      previous === undefined ||
      (previous.status === "staged" && bot.status !== "staged") ||
      ((previous.status === "staged") === (bot.status === "staged") &&
        (bot.generation > previous.generation ||
          (bot.generation === previous.generation && bot.status === "active")))
    )
      selected.set(bot.id, bot);
  }
  return [...selected.values()];
}
