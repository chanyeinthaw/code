import { memoryCodexDisabledReason } from "@t3tools/shared/memoryChat";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Catalog = Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) });
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(Catalog));
export class CodexMemoryCatalogError extends Schema.TaggedError<CodexMemoryCatalogError>()(
  "CodexMemoryCatalogError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

// Model metadata can force code mode and apply_patch even when feature flags disable shell tools.
export const memoryCatalog = Effect.fn("CodexMemoryPolicy.catalog")(function* (text: string) {
  const catalog = yield* decodeCatalog(text);
  if (catalog.models.length === 0)
    return yield* new CodexMemoryCatalogError({ detail: "Codex returned an empty model catalog." });
  return yield* encodeCatalog({
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      tool_mode: "direct",
      use_responses_lite: false,
      experimental_supported_tools: [],
    })),
  });
});

export const memoryThreadConfig = {
  project_doc_max_bytes: 0,
  include_environment_context: false,
  developer_instructions: "",
  user_instructions: "",
  instructions: "",
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  "skills.include_instructions": false,
  model_auto_compact_token_limit: 2_000_000_000,
  web_search: "disabled",
  "tools.view_image": false,
  "tools.update_plan.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  "tools.enabled_tools": [],
  "agents.enabled": false,
  "memories.use_memories": false,
  "memories.generate_memories": false,
  ...Object.fromEntries(
    [
      "goals",
      "multi_agent",
      "multi_agent_v2",
      "default_mode_request_user_input",
      "shell_tool",
      "unified_exec",
      "code_mode",
      "code_mode_host",
      "browser_use",
      "browser_use_external",
      "in_app_browser",
      "computer_use",
      "image_generation",
      "view_image",
      "realtime_conversation",
      "apps",
      "hooks",
      "memories",
      "skill_search",
      "skill_mcp_dependency_install",
      "request_permissions_tool",
      "sleep_tool",
      "tool_suggest",
      "remote_plugin",
    ].map((name) => [`features.${name}`, false]),
  ),
  "features.skip_host_skill_discovery": true,
} satisfies Record<string, Schema.Json>;

const readCommand = Effect.fn("CodexMemoryPolicy.readCommand")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(command);
  yield* process.stderr.pipe(Stream.runDrain, Effect.forkScoped);
  const text = yield* process.stdout.pipe(Stream.decodeText(), Stream.mkString);
  if ((yield* process.exitCode) !== 0)
    return yield* new CodexMemoryCatalogError({
      detail: "Memory chat requires Codex 0.160.0 or newer with model catalog support.",
    });
  return text;
}, Effect.scoped);

export const verifyMemoryVersion = Effect.fn("CodexMemoryPolicy.verifyVersion")(function* (
  command: ChildProcess.Command,
) {
  const reason = memoryCodexDisabledReason(yield* readCommand(command));
  if (reason !== null) return yield* new CodexMemoryCatalogError({ detail: reason });
});

export const writeMemoryCatalog = Effect.fn("CodexMemoryPolicy.writeCatalog")(function* (
  command: ChildProcess.Command,
) {
  const catalog = yield* memoryCatalog(yield* readCommand(command));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-codex-" });
  const catalogPath = path.join(directory, "models.json");
  yield* fs.writeFileString(catalogPath, catalog, { mode: 0o600 });
  return catalogPath;
});

export const prepareMemoryCatalog = Effect.fn("CodexMemoryPolicy.prepareCatalog")(
  function* (commands: {
    readonly version: ChildProcess.Command;
    readonly catalog: ChildProcess.Command;
  }) {
    yield* verifyMemoryVersion(commands.version);
    return yield* writeMemoryCatalog(commands.catalog);
  },
);
