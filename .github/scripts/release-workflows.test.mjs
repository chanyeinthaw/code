import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";

// Use the same YAML parser the shared configuration helpers already depend on.
const { parse } = NodeModule.createRequire(
  new URL("../../packages/shared/package.json", import.meta.url),
)("yaml");
const workflow = (name) =>
  parse(NodeFS.readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8"));
const release = workflow("release.yml");

NodeTest.test("only CI, manual Windows tests, and manual Sora releases are enabled", () => {
  NodeAssert.deepEqual(NodeFS.readdirSync(new URL("../workflows", import.meta.url)).sort(), [
    "ci.yml",
    "release.yml",
    "windows-tests.yml",
  ]);
  NodeAssert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
  NodeAssert.equal(release.on.workflow_dispatch.inputs.version.default, "0.0.0");
  NodeAssert.equal(release.on.workflow_dispatch.inputs.publish.default, false);
  for (const name of ["ci.yml", "windows-tests.yml", "release.yml"]) {
    for (const job of Object.values(workflow(name).jobs)) {
      if (job["runs-on"])
        NodeAssert.match(job["runs-on"], /^(ubuntu-24\.04|windows-2025|macos-15)$/);
    }
  }
});

NodeTest.test(
  "all three release targets compile on Linux and macOS only finalizes artifacts",
  () => {
    NodeAssert.equal(release.jobs.linux["runs-on"], "ubuntu-24.04");
    NodeAssert.equal(release.jobs.cross_build["runs-on"], "ubuntu-24.04");
    NodeAssert.deepEqual(release.jobs.cross_build.strategy.matrix.include, [
      { platform: "mac", arch: "arm64", "rust-target": "aarch64-apple-darwin" },
      { platform: "win", arch: "x64", "rust-target": "x86_64-pc-windows-msvc" },
    ]);
    NodeAssert.equal(release.jobs.sign_mac["runs-on"], "macos-15");
    const commands = release.jobs.sign_mac.steps
      .flatMap((step) => (step.run ? [step.run] : []))
      .join("\n");
    NodeAssert.doesNotMatch(commands, /cargo|build-exe|build:desktop|build-cli-archive/);
    NodeAssert.match(commands, /finalize-macos-release/);
  },
);

NodeTest.test(
  "publication waits for signing and native CLI verification and excludes unsigned mac archives",
  () => {
    NodeAssert.deepEqual(release.jobs.publish.needs, [
      "metadata",
      "linux",
      "sign_mac",
      "verify_windows",
    ]);
    const steps = release.jobs.publish.steps;
    NodeAssert.ok(steps.some((step) => step.with?.name === "mac-signed"));
    const publish = steps.find((step) => step.name === "Publish Sora release").run;
    NodeAssert.match(publish, /cli-assets\/sora-\$VERSION-linux-x64\.tar\.gz/);
    NodeAssert.match(publish, /cli-assets\/sora-\$VERSION-win32-x64\.zip/);
    NodeAssert.doesNotMatch(publish, /cp .*cli-assets\/\*/);
    NodeAssert.ok(publish.indexOf("sha256sum") < publish.indexOf("gh release create"));
    NodeAssert.deepEqual(release.jobs.publish_npm.needs, ["metadata", "publish"]);
  },
);

NodeTest.test("release jobs do not fetch or derive versions from upstream tags", () => {
  for (const job of Object.values(release.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@"))
        NodeAssert.equal(step.with?.["fetch-tags"], false);
      if (step.run)
        NodeAssert.doesNotMatch(
          step.run,
          /git describe|resolve-nightly|previous-release|pingdotgg/,
        );
    }
  }
});

NodeTest.test("server changes schedule the server shards under the renamed package", () => {
  const { decide, readWorkspace } = NodeModule.createRequire(import.meta.url)("./ci-changes.cjs");
  const result = decide(["apps/server/src/bin.ts"], readWorkspace(), false);
  NodeAssert.equal(result.outputs.test_server, true);
  NodeAssert.equal(result.outputs.build, true);
  NodeAssert.ok(!result.outputs.test_packages.split(" ").includes("@satslab/sora"));
});
