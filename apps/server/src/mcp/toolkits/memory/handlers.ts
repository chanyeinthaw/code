import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as MemoryAccess from "../../../memory/MemoryAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemoryToolkit } from "./tools.ts";
const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return (yield* McpInvocationContext.requireThreadScope(scope, "Memory navigation")).thread;
});
const failure = (error: { message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
export const layer = McpToolAccess.toLayer(
  MemoryToolkit,
  Effect.gen(function* () {
    const access = yield* MemoryAccess.MemoryAccess;
    return {
      zoom: McpToolAccess.readsAsCaller((input) =>
        caller.pipe(
          Effect.flatMap((scope) => access.zoom(scope, input.id, input.n)),
          Effect.mapError(failure),
        ),
      ),
      date: McpToolAccess.readsAsCaller((input) =>
        caller.pipe(
          Effect.flatMap((scope) => access.date(scope, input.id)),
          Effect.mapError(failure),
        ),
      ),
      t3_attachment_read: McpToolAccess.readsAsCaller((input) =>
        caller.pipe(
          Effect.flatMap((scope) =>
            access.attachment(scope, {
              attachmentId: input.attachmentId,
              offset: input.offset ?? 0,
              length: input.length ?? 32768,
              encoding: input.encoding ?? "utf8",
            }),
          ),
          Effect.mapError(failure),
        ),
      ),
    };
  }),
);
