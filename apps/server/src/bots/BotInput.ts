import type { ChatAttachment, OrchestrationV2ConversationMessage } from "@satslab/contracts";

export function botMessageText(
  message: Pick<OrchestrationV2ConversationMessage, "text" | "createdBy" | "senderThreadId">,
) {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return message.text;
  return `Message from another Sora agent (not the user):\n${JSON.stringify({ senderThreadId: message.senderThreadId })}\n\n${message.text}`;
}

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
