import type { ChatAttachment } from "@t3tools/contracts";

export function memoryInput(text: string, attachments: ReadonlyArray<ChatAttachment>) {
  const files = attachments.filter((attachment) => attachment.type === "file");
  return {
    text:
      files.length === 0
        ? text
        : `${text}\n\nAttachments for t3_attachment_read:\n${files.map((file) => `${file.id}: ${file.name} (${file.mimeType}, ${file.sizeBytes} bytes)`).join("\n")}`,
    attachments: attachments.filter((attachment) => attachment.type === "image"),
  };
}
