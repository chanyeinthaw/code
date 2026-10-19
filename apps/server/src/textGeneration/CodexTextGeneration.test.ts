import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  output: string;
  lifecycle?: { port: number; command: "exec" | "mcp list" };
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  version?: string;
  catalogExitCode?: number;
  requireBotPolicy?: boolean;
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
}

function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    version: input.version ?? "0.163.0",
    catalogExitCode: input.catalogExitCode ?? 0,
    requireBotPolicy: input.requireBotPolicy ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    mcpServers: input.mcpServers ?? [],
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        'if (args.includes("--version")) { console.log("codex-cli " + check.version); process.exit(0); }',
        'if (args[0] === "debug" && args[1] === "models") {',
        "  if (check.catalogExitCode !== 0) process.exit(check.catalogExitCode);",
        '  console.log(JSON.stringify({ models: [{ slug: "gpt-5.4-mini", tool_mode: "code_mode_only", use_responses_lite: true, experimental_supported_tools: ["apply_patch"] }] }));',
        "  process.exit(0);",
        "}",
        'const isMcpList = args.includes("mcp") && args.includes("list");',
        ...(input.lifecycle === undefined
          ? []
          : [
              `if (isMcpList === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (isMcpList) {",
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        "if (check.requireBotPolicy) {",
        '  const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);',
        `  for (const flag of ${JSON.stringify(["features.shell_tool=false", "features.unified_exec=false", "features.code_mode=false", "features.multi_agent=false", "tools.enabled_tools=[]", 'web_search="disabled"'])}) {`,
        '    if (!configs.includes(flag)) throw new Error("Missing memory policy: " + flag);',
        "  }",
        '  const catalog = configs.find((arg) => arg.startsWith("model_catalog_json="));',
        '  if (!catalog) throw new Error("Missing memory catalog");',
        '  const path = JSON.parse(catalog.slice("model_catalog_json=".length));',
        '  const models = JSON.parse(NodeFS.readFileSync(path, "utf8")).models;',
        '  if (models.some((model) => model.tool_mode !== "direct" || model.use_responses_lite || model.experimental_supported_tools.length)) throw new Error("Unsafe memory catalog");',
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedRuntime?: boolean;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath, launchArgs: input.launchArgs });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment === undefined ? undefined : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedRuntime
        ? Effect.succeed({
            config,
            environment: input.environment ?? process.env,
            revision: "test",
          })
        : undefined,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("compacts memory with coding tools, plugins, and all native MCP servers disabled", () =>
    withFakeCodexEnv(
      {
        output: "Retained context",
        requireBotPolicy: true,
        forbidArg: "--output-schema",
        stdinMustNotContain: "Return JSON",
        mcpServers: [{ name: "native.server", enabled: true }],
        requireArg: '--config mcp_servers={"native.server"={enabled=false}}',
      },
      (generation) =>
        Effect.gen(function* () {
          if (!generation.generateMemorySummary)
            return yield* Effect.die("Missing summary operation");
          const result = yield* generation.generateMemorySummary({
            cwd: process.cwd(),
            instructions: "Summarize",
            context: "Context",
            task: "Compact",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result).toBe("Retained context");
        }),
    ),
  );

  it.effect("rejects older Codex versions for memory compaction", () =>
    withFakeCodexEnv(
      { version: "0.159.0", output: JSON.stringify({ summary: "Must not run" }) },
      (generation) =>
        Effect.gen(function* () {
          if (!generation.generateMemorySummary)
            return yield* Effect.die("Missing summary operation");
          const result = yield* generation
            .generateMemorySummary({
              cwd: process.cwd(),
              instructions: "Summarize",
              context: "Context",
              task: "Compact",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.detail).toContain("0.160.0");
        }),
    ),
  );

  it.effect.each([{ mcpServers: 2 }, { catalogExitCode: 2 }])(
    "continues compaction with its no-tools prompt when tool setup fails: %j",
    (input) =>
      withFakeCodexEnv(
        {
          ...input,
          output: "Retained context",
          stdinMustContain: "Call no tools.",
          requireArg: "--config features.shell_tool=false",
        },
        (generation) =>
          Effect.gen(function* () {
            if (!generation.generateMemorySummary)
              return yield* Effect.die("Missing summary operation");
            const summary = yield* generation.generateMemorySummary({
              cwd: process.cwd(),
              instructions: "Summarize. Call no tools.",
              context: "Context",
              task: "Compact",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(summary).toBe("Retained context");
          }),
      ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg:
          "--config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers (e.g. the worktree branch rename fork) can run
          // after their launching request's scope has closed; temp files must
          // not be tied to that ambient scope or they are reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );
});
