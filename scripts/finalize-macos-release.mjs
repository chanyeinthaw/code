import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { sign } from "@electron/osx-sign";
import { parse, stringify } from "yaml";
import { findMachOBinaries } from "./lib/macos-binaries.mjs";

if (process.env.RUNNER_OS !== "macOS") throw new Error("macOS signing requires macOS.");
const version = process.env.RELEASE_VERSION;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ""))
  throw new Error("Invalid release version.");
const invoke = (command, args, captureOutput = false) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    stdio: captureOutput ? "pipe" : "inherit",
    encoding: "utf8",
  });
  // security arguments can contain passwords; never include argv in an error.
  if (result.status !== 0)
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}.`);
  return result.stdout;
};
const run = (command, args) => invoke(command, args);
const capture = (command, args) => invoke(command, args, true);
const temp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sora-sign-"));
const output = NodePath.resolve("release");
await NodeFSP.mkdir(output, { recursive: true });
const certificate = process.env.CSC_LINK;
const password = process.env.CSC_KEY_PASSWORD;
const apiKey = process.env.APPLE_API_KEY;
const apiKeyId = process.env.APPLE_API_KEY_ID;
const issuer = process.env.APPLE_API_ISSUER;
const developerId = Boolean(certificate && password && apiKey && apiKeyId && issuer);
if (process.env.REQUIRE_DEVELOPER_ID === "true" && !developerId) {
  throw new Error(
    "Publication requires CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.",
  );
}
const keychain = NodePath.join(temp, "signing.keychain-db");
const originalKeychains =
  capture("security", ["list-keychains", "-d", "user"])
    .match(/"[^"]+"/g)
    ?.map((value) => value.slice(1, -1)) ?? [];
let keychainCreated = false;
try {
  let identity = "-";
  if (developerId) {
    const keychainPassword = NodeCrypto.randomBytes(32).toString("hex");
    const cert = NodePath.join(temp, "certificate.p12");
    await NodeFSP.writeFile(cert, Buffer.from(certificate, "base64"), { mode: 0o600 });
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    keychainCreated = true;
    run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", ["import", cert, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
    run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    ]);
    run("security", ["list-keychains", "-d", "user", "-s", keychain, ...originalKeychains]);
    identity = /"(Developer ID Application: [^"]+)"/.exec(
      capture("security", ["find-identity", "-v", "-p", "codesigning", keychain]),
    )?.[1];
    if (!identity) throw new Error("No Developer ID Application certificate found.");
  }
  const keyFile = NodePath.join(temp, "AuthKey.p8");
  if (developerId) await NodeFSP.writeFile(keyFile, apiKey, { mode: 0o600 });
  const notarize = (archive) => {
    if (developerId)
      run("xcrun", [
        "notarytool",
        "submit",
        archive,
        "--key",
        keyFile,
        "--key-id",
        apiKeyId,
        "--issuer",
        issuer,
        "--wait",
      ]);
  };
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
      ...(developerId ? ["--options", "runtime", "--timestamp"] : []),
      ...(file === executable ? ["--entitlements", entitlements] : []),
      file,
    ]);
  }
  const cliNotary = NodePath.join(temp, "cli-notary.zip");
  run("ditto", ["-c", "-k", "--keepParent", cliRoot, cliNotary]);
  notarize(cliNotary);
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
    identityValidation: developerId,
    platform: "darwin",
    optionsForFile: () => ({ entitlements: appEntitlements, hardenedRuntime: developerId }),
  });
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const appNotary = NodePath.join(temp, "app-notary.zip");
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, appNotary]);
  notarize(appNotary);
  if (developerId) run("xcrun", ["stapler", "staple", app]);

  // This step only wraps the already-built, signed app; it performs no compilation.
  const config = NodePath.join(temp, "electron-builder.json");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({
      appId: "xyz.satslab.sora",
      productName: "Sora",
      extraMetadata: { version },
      buildVersion: version,
      artifactName: "Sora-${version}-${arch}.${ext}",
      directories: { output },
      mac: { target: ["dmg", "zip"], identity: null, notarize: false },
      publish: [
        { provider: "github", owner: "chanyeinthaw", repo: "code", releaseType: "release" },
      ],
    }),
  );
  run("node_modules/.bin/vp", [
    "exec",
    "--filter",
    "@satslab/desktop",
    "--",
    "electron-builder",
    "--prepackaged",
    app,
    "--mac",
    "--arm64",
    "--config",
    config,
    "--publish",
    "never",
  ]);
  if (developerId) {
    const dmg = NodePath.join(output, `Sora-${version}-arm64.dmg`);
    notarize(dmg);
    run("xcrun", ["stapler", "staple", dmg]);
  }
  // Stapling mutates the DMG after electron-builder wrote its update metadata.
  const manifestPath = NodePath.join(output, "latest-mac.yml");
  const manifest = parse(await NodeFSP.readFile(manifestPath, "utf8"));
  for (const file of manifest.files) {
    const bytes = await NodeFSP.readFile(NodePath.join(output, NodePath.basename(file.url)));
    file.sha512 = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
    file.size = bytes.length;
    if (file.url === manifest.path) manifest.sha512 = file.sha512;
  }
  await NodeFSP.writeFile(manifestPath, stringify(manifest));
} finally {
  try {
    if (keychainCreated) {
      try {
        run("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains]);
      } finally {
        run("security", ["delete-keychain", keychain]);
      }
    }
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
}
