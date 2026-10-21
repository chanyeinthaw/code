import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { it } from "vite-plus/test";
import sharp from "sharp";

it("exports a valid ICNS containing decodable PNGs from 16 to 1024 pixels", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sora-icons-"));
  try {
    NodeChildProcess.execFileSync(process.execPath, [
      NodeURL.fileURLToPath(new URL("./build-macos-icons.mjs", import.meta.url)),
      NodeURL.fileURLToPath(new URL("../assets/prod/black-macos-1024.png", import.meta.url)),
      root,
    ]);
    const icns = await NodeFSP.readFile(NodePath.join(root, "icon.icns"));
    NodeAssert.equal(icns.toString("ascii", 0, 4), "icns");
    NodeAssert.equal(icns.readUInt32BE(4), icns.length);
    const widths = [];
    for (let offset = 8; offset < icns.length;) {
      const length = icns.readUInt32BE(offset + 4);
      NodeAssert.ok(length > 8 && offset + length <= icns.length);
      const image = await sharp(icns.subarray(offset + 8, offset + length)).metadata();
      NodeAssert.equal(image.format, "png");
      NodeAssert.equal(image.width, image.height);
      widths.push(image.width);
      offset += length;
    }
    NodeAssert.deepEqual(widths, [16, 32, 64, 128, 256, 512, 1024]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
