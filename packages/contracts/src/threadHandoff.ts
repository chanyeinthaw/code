import * as Schema from "effect/Schema";

/**
 * Moving a thread to a hub environment failed or was refused. The message
 * says why and what to do; the move itself, when one started, records it too.
 */
export class ThreadHandoffError extends Schema.TaggedError<ThreadHandoffError>()(
  "ThreadHandoffError",
  {
    reason: Schema.Literals(["not_found", "refused", "failed"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
