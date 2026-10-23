import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@satslab/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;
const decodeDiscordInput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.Literal("discord"),
      sender: Schema.Struct({ displayName: Schema.String }),
      text: Schema.String,
    }),
  ),
);

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "sora" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  readonly sourceLabel?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // Integration input IDs are assigned by the server, so pasted routing JSON stays ordinary text.
  if (message.creationSource === "server" && message.id?.startsWith("bot-input:")) {
    const envelope = decodeDiscordInput(message.text.slice(message.text.lastIndexOf("\n\n") + 2));
    if (Option.isSome(envelope))
      return {
        text: envelope.value.text,
        attribution: "agent",
        sourceLabel: `Discord · ${envelope.value.sender.displayName}`,
        scheduledTaskId: undefined,
      };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    text: message.text,
    attribution:
      message.createdBy !== "agent" ? null : message.creationSource === "server" ? "sora" : "agent",
    scheduledTaskId: undefined,
  };
}
