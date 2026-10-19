import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EventId,
  MessageId,
  EnvironmentId,
  MemoryId,
  ThreadId,
  type MemoryTransfer,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as MemoryTransferFiles from "./MemoryTransferFiles.ts";
import { ensureWorkspace } from "./MemoryWorkspace.ts";

const layer = MemoryTransferFiles.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-files-" })),
  Layer.provideMerge(NodeServices.layer),
);
const memoryId = MemoryId.make("../personal/🪻");
const transfer: MemoryTransfer = {
  transferId: "transfer-one",
  releaseHash: "unused",
  destinationEnvironmentId: EnvironmentId.make("destination"),
  identity: {
    id: memoryId,
    name: "Personal",
    threadId: ThreadId.make("thread"),
    ownerEnvironmentId: EnvironmentId.make("destination"),
    generation: 1,
    status: "staged",
    destinationEnvironmentId: null,
  },
  state: {
    parts: [],
    pending: false,
    revision: 0,
    compactParts: [],
    compactPending: false,
    compactRevision: -1,
    total: 0,
    frontier: 0,
  },
  messages: [],
  nodes: [],
  jobs: [],
  snapshots: [],
  events: [],
  attachments: [],
  workspace: [],
};

it.effect(
  "keeps a stable identity workspace and transfers binary files and empty directories",
  () =>
    Effect.gen(function* () {
      const files = yield* MemoryTransferFiles.MemoryTransferFiles;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const workspace = yield* ensureWorkspace(memoryId);
      assert.equal(yield* ensureWorkspace(memoryId), workspace);
      assert.isTrue(workspace.startsWith(path.join(config.stateDir, "memory") + path.sep));
      yield* fs.makeDirectory(path.join(workspace, "empty"));
      yield* fs.writeFile(path.join(workspace, "bytes.bin"), new Uint8Array([0, 255, 3, 128]));
      const exported = yield* files.exportWorkspace(memoryId);
      yield* fs.writeFile(path.join(workspace, "stale"), new Uint8Array([1]));
      assert.equal(yield* files.importWorkspace({ ...transfer, workspace: exported }), workspace);
      assert.deepEqual(
        Array.from(yield* fs.readFile(path.join(workspace, "bytes.bin"))),
        [0, 255, 3, 128],
      );
      assert.isTrue(yield* fs.exists(path.join(workspace, "empty")));
      assert.isFalse(yield* fs.exists(path.join(workspace, "stale")));
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects traversal and malformed file bytes before replacing the workspace", () =>
  Effect.gen(function* () {
    const files = yield* MemoryTransferFiles.MemoryTransferFiles;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* ensureWorkspace(memoryId);
    yield* fs.writeFile(path.join(workspace, "keep"), new Uint8Array([42]));
    for (const entry of [
      { path: "../escape", data: "YQ==" },
      { path: "invalid", data: "not base64" },
    ]) {
      assert.equal(
        (yield* Effect.result(files.importWorkspace({ ...transfer, workspace: [entry] })))._tag,
        "Failure",
      );
      assert.deepEqual(Array.from(yield* fs.readFile(path.join(workspace, "keep"))), [42]);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("transfers attachment bytes and rejects conflicting metadata or existing content", () =>
  Effect.gen(function* () {
    const files = yield* MemoryTransferFiles.MemoryTransferFiles;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const now = yield* DateTime.now;
    const attachment = {
      type: "file" as const,
      id: ChatAttachmentId.make("binary"),
      name: "document.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 4,
    };
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make("attached"),
      threadId: transfer.identity.threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: "Keep this file",
      attachments: [attachment],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
    };
    const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    assert.ok(path);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    const bytes = new Uint8Array([0, 255, 128, 42]);
    yield* fs.writeFile(path, bytes);
    const exported = yield* files.exportAttachments([attachment]);
    const exportedFile = exported[0];
    assert.ok(exportedFile);
    const moved: MemoryTransfer = {
      ...transfer,
      attachments: exported,
      events: [
        {
          id: EventId.make("attached"),
          threadId: message.threadId,
          occurredAt: now,
          type: "message.updated",
          payload: message,
        },
      ],
    };
    yield* fs.remove(path);
    yield* files.importAttachments(moved);
    yield* files.importAttachments(moved);
    assert.deepEqual(Array.from(yield* fs.readFile(path)), Array.from(bytes));
    assert.equal(
      (yield* Effect.result(
        files.importAttachments({
          ...moved,
          attachments: [{ ...exportedFile, attachment: { ...attachment, name: "different.bin" } }],
        }),
      ))._tag,
      "Failure",
    );
    yield* fs.writeFile(path, new Uint8Array([1, 2, 3, 4]));
    assert.equal((yield* Effect.result(files.importAttachments(moved)))._tag, "Failure");
    assert.deepEqual(Array.from(yield* fs.readFile(path)), [1, 2, 3, 4]);
  }).pipe(Effect.provide(layer)),
);
