import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw new Error("Usage: build-macos-icons.mjs <source.png> <output-directory>");
const chunks = [];
for (const [type, size] of [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
]) {
  const png = await sharp(source).resize(size, size).png().toBuffer();
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
await NodeFSP.writeFile(
  NodePath.join(destination, "icon.icns"),
  Buffer.concat([header, ...chunks]),
);
await sharp(source).resize(512, 512).png().toFile(NodePath.join(destination, "icon.png"));
