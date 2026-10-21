import { ChatAttachment, BotChatError, type BotId, type BotTransfer } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { makeEnsureWorkspace } from "./BotWorkspace.ts";

const encodeAttachment = Schema.encodeEffect(Schema.fromJsonString(ChatAttachment));

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const ensureWorkspace = yield* makeEnsureWorkspace;
  const exportWorkspace = Effect.fn("BotTransferFiles.exportWorkspace")(function* (id: BotId) {
    const root = yield* fs.realPath(yield* ensureWorkspace(id));
    const files: BotTransfer["workspace"][number][] = [];
    const pending = [""];
    while (pending.length) {
      const directory = pending.pop();
      if (directory === undefined) break;
      for (const name of yield* fs.readDirectory(path.join(root, directory))) {
        const relative = directory ? `${directory}/${name}` : name;
        const absolute = path.join(root, relative);
        // A workspace transfer must not follow links into another workspace or the host.
        if ((yield* fs.realPath(absolute)) !== absolute)
          return yield* new BotChatError({
            operation: "workspace-transfer",
            reason: "invalid-transfer",
          });
        const info = yield* fs.stat(absolute);
        if (info.type === "Directory") {
          files.push({ path: relative, data: null });
          pending.push(relative);
        } else if (info.type === "File")
          files.push({
            path: relative,
            data: Buffer.from(yield* fs.readFile(absolute)).toString("base64"),
          });
        else
          return yield* new BotChatError({
            operation: "workspace-transfer",
            reason: "invalid-transfer",
          });
      }
    }
    return files;
  });

  const importWorkspace = Effect.fn("BotTransferFiles.importWorkspace")(function* (
    transfer: BotTransfer,
  ) {
    const workspace = yield* ensureWorkspace(transfer.identity.id);
    const staging = `${workspace}-incoming-${encodeURIComponent(transfer.transferId)}`;
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* fs.makeDirectory(staging, { recursive: true });
    for (const file of transfer.workspace) {
      if (
        file.path.includes("\\") ||
        file.path.includes(":") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        return yield* new BotChatError({
          operation: "workspace-transfer",
          reason: "invalid-transfer",
        });
      const destination = path.join(staging, file.path);
      if (file.data === null) {
        yield* fs.makeDirectory(destination, { recursive: true });
      } else {
        const bytes = Buffer.from(file.data, "base64");
        if (bytes.toString("base64") !== file.data)
          return yield* new BotChatError({
            operation: "workspace-transfer",
            reason: "invalid-transfer",
          });
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.writeFile(destination, bytes, { flag: "wx" });
      }
    }
    yield* fs.remove(workspace, { recursive: true, force: true });
    yield* fs.rename(staging, workspace);
    return workspace;
  });

  const exportAttachments = Effect.fn("BotTransferFiles.exportAttachments")(function* (
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    return yield* Effect.forEach(
      [...new Map(attachments.map((attachment) => [attachment.id, attachment])).values()],
      (attachment) =>
        Effect.gen(function* () {
          const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
          if (file === null)
            return yield* new BotChatError({
              operation: "attachment-transfer",
              reason: "invalid-transfer",
            });
          return { attachment, data: Buffer.from(yield* fs.readFile(file)).toString("base64") };
        }),
    );
  });
  const importAttachments = Effect.fn("BotTransferFiles.importAttachments")(function* (
    transfer: BotTransfer,
  ) {
    const visible = new Map(
      transfer.events.flatMap((event) =>
        event.type === "message.updated"
          ? event.payload.attachments.map((attachment) => [attachment.id, attachment] as const)
          : [],
      ),
    );
    if (visible.size !== transfer.attachments.length)
      return yield* new BotChatError({
        operation: "attachment-transfer",
        reason: "invalid-transfer",
      });
    for (const { attachment, data } of transfer.attachments) {
      const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      const advertised = visible.get(attachment.id);
      if (
        file === null ||
        !advertised ||
        (yield* encodeAttachment(advertised)) !== (yield* encodeAttachment(attachment))
      )
        return yield* new BotChatError({
          operation: "attachment-transfer",
          reason: "invalid-transfer",
        });
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("base64") !== data)
        return yield* new BotChatError({
          operation: "attachment-transfer",
          reason: "invalid-transfer",
        });
      if (yield* fs.exists(file)) {
        if (!Buffer.from(yield* fs.readFile(file)).equals(bytes))
          return yield* new BotChatError({
            operation: "attachment-transfer",
            reason: "invalid-transfer",
          });
        continue;
      }
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFile(file, bytes, { flag: "wx" });
    }
  });

  return { exportWorkspace, importWorkspace, exportAttachments, importAttachments };
});
export class BotTransferFiles extends Context.Service<
  BotTransferFiles,
  Effect.Success<typeof make>
>()("@satslab/sora/bots/BotTransferFiles") {}
export const layer = Layer.effect(BotTransferFiles, make);
