import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "vite-plus/test";
import { findMachOBinaries } from "./macos-binaries.mjs";

it("finds vendor binaries without suffixes and excludes scripts and foreign natives", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sora-mach-o-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "vendor"));
    await NodeFSP.writeFile(
      NodePath.join(root, "vendor/rg"),
      Buffer.from("cffaedfe00000000", "hex"),
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "addon.node"),
      Buffer.from("cafebabe00000000", "hex"),
    );
    await NodeFSP.writeFile(
      NodePath.join(root, "foreign.node"),
      Buffer.from("7f454c4600000000", "hex"),
    );
    await NodeFSP.writeFile(NodePath.join(root, "run"), "#!/bin/sh\n");
    await NodeFSP.writeFile(NodePath.join(root, "empty"), "");
    NodeAssert.deepEqual(
      (await findMachOBinaries(root)).map((file) => NodePath.relative(root, file)).sort(),
      ["addon.node", NodePath.join("vendor", "rg")],
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
