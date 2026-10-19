import { expect, it } from "vite-plus/test";
import { memoryInput } from "./MemoryInput.ts";

it("gives providers attachment IDs for selective reads and keeps images native", () => {
  const image = {
    type: "image" as const,
    id: "image-one",
    name: "photo.png",
    mimeType: "image/png",
    sizeBytes: 10,
  };
  const file = {
    type: "file" as const,
    id: "file-one",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 256,
  };
  const input = memoryInput("Read the report", [image, file]);
  expect(input.attachments).toEqual([image]);
  expect(input.text).toContain("file-one: report.pdf (application/pdf, 256 bytes)");
  expect(input.text).toContain("t3_attachment_read");
  expect(memoryInput("Follow up", []).text).toBe("Follow up");
});
