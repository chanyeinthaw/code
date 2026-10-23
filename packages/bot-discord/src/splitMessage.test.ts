import { expect, it } from "vite-plus/test";
import { splitMessage } from "./splitMessage.ts";

it("preserves text and Unicode while splitting at readable boundaries", () => {
  const text = `First paragraph.\n\n${"hello 🐱 ".repeat(600)}`;
  const chunks = splitMessage(text, 2000);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => chunk.length <= 2000 && chunk.isWellFormed())).toBe(true);
});

it("closes and reopens code fences within the limit", () => {
  const text = `Before\n\n\`\`\`typescript\n${"const x = 1;\n".repeat(500)}\`\`\`\nAfter`;
  const chunks = splitMessage(text, 2000);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  expect(chunks.every((chunk) => (chunk.match(/^```/gm)?.length ?? 0) % 2 === 0)).toBe(true);
  expect(chunks.at(-1)).toContain("After");
});

it("keeps oversized fence declarations and Unicode within the hard limit", () => {
  const text = `\`\`\`${"x".repeat(1990)}\n${"🐱".repeat(40)}\n\`\`\``;
  const chunks = splitMessage(text, 2000);
  expect(
    chunks.every((chunk) => chunk.length > 0 && chunk.length <= 2000 && chunk.isWellFormed()),
  ).toBe(true);
  expect(chunks.join("")).toContain("🐱");
});
