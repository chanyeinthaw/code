import { botCodexDisabledReason } from "@t3tools/shared/botChat";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Catalog = Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) });
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(Catalog));
export class CodexBotCatalogError extends Schema.TaggedError<CodexBotCatalogError>()(
  "CodexBotCatalogError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

// Model metadata can force code mode and apply_patch even when feature flags disable shell tools.
export const botCatalog = Effect.fn("CodexBotPolicy.catalog")(function* (text: string) {
  const catalog = yield* decodeCatalog(text);
  if (catalog.models.length === 0)
    return yield* new CodexBotCatalogError({ detail: "Codex returned an empty model catalog." });
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

export const botThreadConfig = {
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
      "bots",
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

const readCommand = Effect.fn("CodexBotPolicy.readCommand")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(command);
  yield* process.stderr.pipe(Stream.runDrain, Effect.forkScoped);
  const text = yield* process.stdout.pipe(Stream.decodeText(), Stream.mkString);
  if ((yield* process.exitCode) !== 0)
    return yield* new CodexBotCatalogError({
      detail: "Bots require Codex 0.160.0 or newer with model catalog support.",
    });
  return text;
}, Effect.scoped);

export const verifyBotVersion = Effect.fn("CodexBotPolicy.verifyVersion")(function* (
  command: ChildProcess.Command,
) {
  const reason = botCodexDisabledReason(yield* readCommand(command));
  if (reason !== null) return yield* new CodexBotCatalogError({ detail: reason });
});

export const writeBotCatalog = Effect.fn("CodexBotPolicy.writeCatalog")(function* (
  command: ChildProcess.Command,
) {
  const catalog = yield* botCatalog(yield* readCommand(command));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-codex-" });
  const catalogPath = path.join(directory, "models.json");
  yield* fs.writeFileString(catalogPath, catalog, { mode: 0o600 });
  return catalogPath;
});

export const prepareBotCatalog = Effect.fn("CodexBotPolicy.prepareCatalog")(function* (commands: {
  readonly version: ChildProcess.Command;
  readonly catalog: ChildProcess.Command;
}) {
  yield* verifyBotVersion(commands.version);
  return yield* writeBotCatalog(commands.catalog);
});
