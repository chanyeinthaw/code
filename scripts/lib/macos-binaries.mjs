import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const magicValues = new Set([
  "cffaedfe",
  "cefaedfe",
  "feedfacf",
  "feedface",
  "cafebabe",
  "bebafeca",
]);

// Vendor helpers such as rg have no suffix but still require signing.
export async function findMachOBinaries(root) {
  const binaries = [];
  for (const entry of await NodeFSP.readdir(root, { recursive: true })) {
    const file = NodePath.join(root, entry);
    if (!(await NodeFSP.stat(file)).isFile()) continue;
    const handle = await NodeFSP.open(file, "r");
    try {
      const magic = Buffer.alloc(4);
      const { bytesRead } = await handle.read(magic, 0, 4, 0);
      if (bytesRead === 4 && magicValues.has(magic.toString("hex"))) binaries.push(file);
    } finally {
      await handle.close();
    }
  }
  return binaries;
}
