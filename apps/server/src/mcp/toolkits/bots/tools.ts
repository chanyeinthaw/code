import { OrchestratorMcpFailure } from "@satslab/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as MemoryAccess from "../../../bots/MemoryAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [MemoryAccess.MemoryAccess, McpInvocationContext.McpInvocationContext],
};
const index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const MemoryToolkit = Toolkit.make(
  Tool.make("zoom", {
    ...shared,
    description:
      "Open an aligned power-of-two range of this turn's frozen memory. n=1 returns the complete original; larger ranges return their two child summaries.",
    parameters: Schema.Struct({ id: index, n: Schema.Int.check(Schema.isGreaterThan(0)) }),
    success: Schema.String,
  }).annotate(Tool.Readonly, true),
  Tool.make("date", {
    ...shared,
    description: "Read the timestamp of an original message in this turn's frozen memory.",
    parameters: Schema.Struct({ id: index }),
    success: Schema.String,
  }).annotate(Tool.Readonly, true),
  Tool.make("s3_attachment_read", {
    ...shared,
    description:
      "Read bytes of a non-image attachment belonging to this memory by attachment ID. Use utf8 for text or base64 for binary. Offsets and lengths are bytes; continue from nextOffset.",
    parameters: Schema.Struct({
      attachmentId: Schema.String,
      offset: Schema.optional(index),
      length: Schema.optional(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(65536)),
      ),
      encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
    }),
    success: Schema.Struct({
      name: Schema.String,
      mimeType: Schema.String,
      offset: index,
      nextOffset: index,
      content: Schema.String,
    }),
  }).annotate(Tool.Readonly, true),
);
