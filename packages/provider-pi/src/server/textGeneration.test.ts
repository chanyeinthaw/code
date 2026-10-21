import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@satslab/contracts";
import { createModelSelection } from "@satslab/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";

import { makePiTextGeneration } from "./textGeneration.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakePi = (reply: string, setModelError?: string) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const received: Array<Record<string, unknown>> = [];
    const emit = (record: Record<string, unknown>) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
    let buffered = "";
    const onStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        buffered += new TextDecoder().decode(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const record = decodeJsonLine(line) as Record<string, unknown>;
          received.push(record);
          const response = { type: "response", id: record["id"], command: record["type"] };
          if (record["type"] === "prompt") {
            yield* emit({ ...response, success: true });
            yield* emit({ type: "agent_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "set_model" && setModelError !== undefined) {
            yield* emit({ ...response, success: false, error: setModelError });
          } else {
            yield* emit({ ...response, success: true });
          }
        }
      });
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) launches.push(command.args);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          // Outside the valid pid range, so PiRpc's process-group kill never lands.
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return { spawner, received, launches };
  });

it.effect("names the model and the disabled extensions when Pi cannot load it", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("", "Model not found: demo/demo-model");
    const textGeneration = yield* makePiTextGeneration(
      { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    const error = yield* textGeneration
      .generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model"),
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Pi rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.include(error.detail, "--no-extensions");
    assert.isUndefined(pi.received.find((record) => record["type"] === "prompt"));
  }),
);

it.effect("compacts bot memory without context files, skills, or prompt templates", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi("Retained context");
    const generation = yield* makePiTextGeneration({
      enabled: true,
      binaryPath: "pi",
      launchArgs: "",
      customModels: [],
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    if (!generation.generateMemorySummary) return yield* Effect.die("Missing summary operation");
    const summary = yield* generation.generateMemorySummary({
      cwd: "/bots",
      instructions: "Summarize",
      context: "Context",
      task: "Compact",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model"),
    });
    assert.equal(summary, "Retained context");
    for (const flag of [
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-extensions",
      "--no-tools",
    ])
      assert.include(pi.launches[0] ?? [], flag);
  }).pipe(Effect.scoped),
);
