import { BotChatError, type BotId } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";

export const makeEnsureWorkspace = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("BotWorkspace.ensure")(function* (id: BotId) {
    // The prefix also makes dot-only IDs safe when an identity is imported.
    const workspace = path.join(
      config.stateDir,
      "bots",
      `bot-${encodeURIComponent(id)}`,
      "workspace",
    );
    yield* fs
      .makeDirectory(workspace, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new BotChatError({ operation: "workspace", reason: "storage", cause }),
        ),
      );
    return workspace;
  });
});
