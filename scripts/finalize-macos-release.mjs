import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { sign } from "@electron/osx-sign";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import { findMachOBinaries } from "./lib/macos-binaries.mjs";

if (process.env.RUNNER_OS !== "macOS") throw new Error("macOS signing requires macOS.");
const version = process.env.RELEASE_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ""))
  throw new Error("Invalid release version.");
const run = (command, args) => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}.`);
};
const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sora-sign-"));
const output = NodePath.resolve("release");
await NodeFSP.mkdir(output, { recursive: true });
try {
  const identity = "-";
  const cliStem = `sora-${version}-darwin-arm64`;
  run("tar", ["-xzf", NodePath.resolve(`mac-input/${cliStem}.tar.gz`), "-C", temp]);
  const cliRoot = NodePath.join(temp, cliStem);
  const entitlements = NodePath.resolve("apps/server/resources/cli-entitlements.plist");
  const executable = NodePath.join(cliRoot, "sora");
  const binaries = await findMachOBinaries(cliRoot);
  for (const file of [...binaries.filter((name) => name !== executable), executable]) {
    run("codesign", [
      "--force",
      "--sign",
      identity,
      ...(file === executable ? ["--entitlements", entitlements] : []),
      file,
    ]);
  }
  run("tar", ["-czf", NodePath.join(output, `${cliStem}.tar.gz`), "-C", temp, cliStem]);

  run("ditto", ["-x", "-k", NodePath.resolve(`mac-input/Sora-${version}-arm64.zip`), temp]);
  const app = NodePath.join(temp, "Sora.app");
  // osx-sign walks nested frameworks, helpers, and native addons before the app.
  const appEntitlements = NodePath.join(temp, "electron-entitlements.plist");
  const cliEntitlements = await NodeFSP.readFile(entitlements, "utf8");
  await NodeFSP.writeFile(
    appEntitlements,
    cliEntitlements.replace(
      "</dict>",
      "<key>com.apple.security.device.camera</key><true/><key>com.apple.security.device.audio-input</key><true/></dict>",
    ),
  );
  await sign({
    app,
    identity,
    identityValidation: false,
    platform: "darwin",
    optionsForFile: () => ({ entitlements: appEntitlements, hardenedRuntime: false }),
  });
  run("codesign", ["--verify", "--deep", "--strict", app]);
  // This step only wraps the already-built, signed app; it performs no compilation.
  // The app already carries its icon from the cross-build. The DMG volume icon and
  // themed background are staged here, matching build-desktop-artifact's DMG target.
  const resources = NodePath.join(temp, "build-resources");
  await NodeFSP.mkdir(NodePath.join(resources, "dmg"), { recursive: true });
  run("node", [
    NodePath.resolve("scripts/build-macos-icons.mjs"),
    NodePath.resolve("assets/prod/black-macos-1024.png"),
    resources,
  ]);
  for (const [suffix, width, height] of [
    ["", 640, 432],
    ["@2x", 1280, 864],
  ]) {
    run("sips", [
      "-s",
      "format",
      "png",
      "-z",
      String(height),
      String(width),
      NodePath.resolve("apps/desktop/resources/dmg/dmg-background-latest.svg"),
      "--out",
      NodePath.join(resources, "dmg", `dmg-background-latest${suffix}.png`),
    ]);
  }
  const config = NodePath.join(temp, "electron-builder.json");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({
      appId: "xyz.satslab.sora",
      productName: "Sora",
      extraMetadata: { version },
      buildVersion: version,
      artifactName: "Sora-${version}-${arch}.${ext}",
      directories: { output, buildResources: resources },
      mac: { target: ["dmg", "zip"], icon: "icon.icns", identity: null, notarize: false },
      dmg: {
        title: `Sora ${version} Installer`,
        background: "dmg/dmg-background-latest.png",
        // Finder's 32px title bar comes out of the image height.
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      },
      publish: [{ provider: "github", owner: "satslab", repo: "sora", releaseType: "release" }],
    }),
  );
  // electron-builder rejects `electron` under `dependencies` in the manifest it reads, and the
  // checkout's manifest keeps it there for the runtime. Give it a devDependencies-only manifest,
  // the same shape build-desktop-artifact stages.
  await NodeFSP.writeFile(
    NodePath.join(temp, "package.json"),
    JSON.stringify({
      name: desktopPackageJson.name,
      devDependencies: { electron: desktopPackageJson.dependencies.electron },
    }),
  );
  run("node_modules/.bin/vp", [
    "exec",
    "--filter",
    "@satslab/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    temp,
    "--prepackaged",
    app,
    "--mac",
    "--arm64",
    "--config",
    config,
    "--publish",
    "never",
  ]);
} finally {
  await NodeFSP.rm(temp, { recursive: true, force: true });
}
