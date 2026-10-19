import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const decodeCatalog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }),
  ),
);
import { botCatalog, isolatedBotHome, prepareBotCatalog } from "./CodexBotPolicy.ts";

it.effect("shares only the selected Codex profile's config and login with bot sessions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* fs.makeTempDirectoryScoped({ prefix: "sora-codex-profile-" });
    for (const name of ["config.toml", "auth.json", "models_cache.json", "AGENTS.md"])
      yield* fs.writeFileString(path.join(source, name), name);
    yield* fs.makeDirectory(path.join(source, "skills"));
    const home = yield* Effect.scoped(
      Effect.gen(function* () {
        const home = yield* isolatedBotHome(source, source);
        assert.notEqual(home, source);
        assert.deepEqual((yield* fs.readDirectory(home)).sort(), [
          "auth.json",
          "config.toml",
          "models_cache.json",
        ]);
        assert.equal(yield* fs.readFileString(path.join(home, "auth.json")), "auth.json");
        return home;
      }),
    );
    assert.isTrue(yield* fs.exists(home));
    const homes = yield* Effect.all(
      [isolatedBotHome(source, source), isolatedBotHome(source, source)],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(homes, [home, home]);
    const otherSource = path.join(source, "other-profile");
    yield* fs.makeDirectory(otherSource);
    yield* fs.writeFileString(path.join(otherSource, "auth.json"), "other-login");
    const otherHome = yield* isolatedBotHome(otherSource, source);
    assert.notEqual(home, otherHome);
    assert.equal(yield* fs.readFileString(path.join(otherHome, "auth.json")), "other-login");
    assert.equal(yield* fs.readFileString(path.join(source, "AGENTS.md")), "AGENTS.md");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("changes tool metadata without changing custom model IDs or capabilities", () =>
  Effect.gen(function* () {
    const model = {
      slug: "custom-gpt",
      context_window: 256000,
      supported_reasoning_levels: [{ effort: "ultra", description: "Custom effort" }],
      service_tiers: [{ id: "priority" }],
      tool_mode: "code_mode_only",
      use_responses_lite: true,
      experimental_supported_tools: ["apply_patch"],
      provider_extension: { enabled: true },
    };
    const result = decodeCatalog(yield* botCatalog(JSON.stringify({ models: [model] })));
    assert.deepEqual(result.models, [
      {
        ...model,
        tool_mode: "direct",
        use_responses_lite: false,
        experimental_supported_tools: [],
      },
    ]);
  }),
);

it.effect("rejects missing or empty catalogs instead of enabling coding tools", () =>
  Effect.gen(function* () {
    assert.equal((yield* Effect.exit(botCatalog("{}")))._tag, "Failure");
    assert.equal((yield* Effect.exit(botCatalog('{"models":[]}')))._tag, "Failure");
  }),
);

it.effect("rejects an older Codex executable before probing its catalog", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-version-" });
    const marker = path.join(directory, "catalog-started");
    const result = yield* prepareBotCatalog({
      version: ChildProcess.make(process.execPath, ["-e", 'console.log("codex-cli 0.159.0")']),
      catalog: ChildProcess.make(process.execPath, [
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "started")',
        marker,
      ]),
    }).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(result.failure.message, "0.160.0");
    assert.isFalse(yield* fs.exists(marker));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
