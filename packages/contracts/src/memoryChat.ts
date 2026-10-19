import { OrchestrationV2DomainEvent } from "./orchestrationV2.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, RunId, MemoryId } from "./baseSchemas.ts";

// These providers expose a built-in tool policy while preserving native MCP servers.
export const MEMORY_CHAT_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "pi",
  "opencode",
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
export const MemoryIdentity = Schema.Struct({
  id: MemoryId,
  name: Schema.String,
  ownerEnvironmentId: EnvironmentId,
  threadId: ThreadId,
  generation: Schema.Int,
  status: Schema.Literals(["active", "transferring", "staged", "forwarded", "deleted"]),
  destinationEnvironmentId: Schema.NullOr(EnvironmentId),
});
export type MemoryIdentity = typeof MemoryIdentity.Type;
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
  memoryId: MemoryId,
  runId: RunId,
  total: Schema.Int,
  view: Schema.String,
});
export type MemorySnapshot = typeof MemorySnapshot.Type;
export class MemoryChatError extends Schema.TaggedError<MemoryChatError>()("MemoryChatError", {
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
        return "Memory identity was not found.";
      case "not-owner":
        return "This environment does not own this memory.";
      case "busy":
        return "Memory has an active turn or ownership transfer.";
      case "invalid-range":
        return "Use an aligned power-of-two range within the frozen memory.";
      case "not-ready":
        return "Memory summaries are not ready. Your history is saved; retry the turn.";
      case "inference":
        return "Memory compaction failed. Your history is saved; retry the turn.";
      case "invalid-transfer":
        return "Memory transfer state or ownership proof is invalid.";
      case "storage":
        return "Memory storage operation failed.";
    }
  }
}
export const MemoryTransfer = Schema.Struct({
  transferId: Schema.String,
  releaseHash: Schema.String,
  identity: MemoryIdentity,
  destinationEnvironmentId: EnvironmentId,
  state: MemoryState,
  messages: Schema.Array(MemoryMessage),
  nodes: Schema.Array(MemoryNode),
  jobs: Schema.Array(MemoryJob),
  snapshots: Schema.Array(MemorySnapshot),
  events: Schema.Array(OrchestrationV2DomainEvent),
  workspace: Schema.Array(
    Schema.Struct({ path: Schema.String, data: Schema.NullOr(Schema.String) }),
  ),
  attachments: Schema.Array(Schema.Struct({ attachment: ChatAttachment, data: Schema.String })),
});
export type MemoryTransfer = typeof MemoryTransfer.Type;

/** A staged transfer is never authoritative while its source is still visible. */
export function selectMemoryIdentities(identities: readonly MemoryIdentity[]) {
  const selected = new Map<MemoryId, MemoryIdentity>();
  for (const memory of identities) {
    const previous = selected.get(memory.id);
    if (
      previous === undefined ||
      (previous.status === "staged" && memory.status !== "staged") ||
      ((previous.status === "staged") === (memory.status === "staged") &&
        (memory.generation > previous.generation ||
          (memory.generation === previous.generation && memory.status === "active")))
    )
      selected.set(memory.id, memory);
  }
  return [...selected.values()];
}
