import type { ChatAttachment } from "@satslab/contracts";

export function botInput(text: string, attachments: ReadonlyArray<ChatAttachment>) {
  const files = attachments.filter((attachment) => attachment.type === "file");
  return {
    text:
      files.length === 0
        ? text
        : `${text}\n\nAttachments for s3_attachment_read:\n${files.map((file) => `${file.id}: ${file.name} (${file.mimeType}, ${file.sizeBytes} bytes)`).join("\n")}`,
    attachments: attachments.filter((attachment) => attachment.type === "image"),
  };
}
