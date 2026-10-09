// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- CLI integration tests own subprocesses, wall-clock desktop tokens, and temporary HTTP listeners.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  HubAccessSnapshot,
  HubEnvironmentCatalog,
  HubLocalEnvironmentState,
  ExecutionEnvironmentDescriptor,
  type DesktopBackendBootstrap,
} from "@t3tools/contracts";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decodeLocalEnvironment = Schema.decodeUnknownSync(HubLocalEnvironmentState);
const decodeCatalog = Schema.decodeUnknownSync(HubEnvironmentCatalog);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }));
const decodeCredential = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }));
const decodeRole = Schema.decodeUnknownSync(Schema.Struct({ role: Schema.String }));
const decodeAccess = Schema.decodeUnknownSync(HubAccessSnapshot);

const cwd = NodeURL.fileURLToPath(new URL("../../../..", import.meta.url));

async function startCli(args: string[], readyText: string, bootstrap?: DesktopBackendBootstrap) {
  const env = { ...process.env };
  for (const key of [
    "T3_SERVICE_LAUNCHER_CONTEXT",
    "T3_BOOT_SERVICE_UNIT",
    "T3CODE_BOOTSTRAP_FD",
    "T3CODE_DESKTOP_CONTROL_FD",
    "VITE_DEV_SERVER_URL",
    "T3CODE_MODE",
    "T3CODE_HOST",
    "T3CODE_LOG_LEVEL",
  ])
    delete env[key];
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", ...args, ...(bootstrap ? ["--bootstrap-fd", "3"] : [])],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  if (bootstrap) {
    const channel = child.stdio[3];
    if (!channel || !("end" in channel)) throw new Error("Missing desktop bootstrap channel");
    channel.end(`${JSON.stringify(bootstrap)}\n`);
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const { stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error("Missing CLI output streams");
  let output = "";
  stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const stop = async () => {
    child.kill("SIGTERM");
    await exited;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = AbortSignal.timeout(20_000);
      deadline.addEventListener(
        "abort",
        () => reject(new Error(`CLI did not become ready: ${output}`)),
        { once: true },
      );
      child.on("error", reject);
      child.once("exit", () => reject(new Error(output)));
      stdout.on("data", (data: Buffer) => {
        output += data.toString();
        if (output.includes(readyText)) resolve();
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop, output: () => output };
}

async function authenticate(
  origin: string,
  cli: Awaited<ReturnType<typeof startCli>>,
  local = true,
) {
  const token =
    /pairingUrl: .*?[#]token=([^&\s]+)/.exec(cli.output())?.[1] ??
    /Hub pairing token: ([^\s]+)/.exec(cli.output())?.[1];
  if (!token) throw new Error("Missing startup credential");
  return authenticateCredential(origin, decodeURIComponent(token), local);
}

async function authenticateCredential(origin: string, credential: string, local = true) {
  const response = await fetch(`${origin}/hub/${local ? "local-auth" : "auth"}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ credential }),
  });
  const result = decodeToken(await response.json());
  return { authorization: `Bearer ${result.token}` };
}

async function listen(server: NodeHttp.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return address.port;
}

async function close(server: NodeHttp.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("serves a client and empty hub without creating an execution database", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-serve-no-environment-"));
  const web = NodeHttp.createServer((_request, response) => response.end("test client"));
  const webPort = await listen(web);
  const probe = NodeHttp.createServer();
  const port = await listen(probe);
  await close(probe);
  let cli: Awaited<ReturnType<typeof startCli>> | undefined;
  try {
    const args = [
      "serve",
      "--no-environment",
      "--public-url",
      "https://pulse.example.test",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--dev-url",
      `http://127.0.0.1:${webPort}`,
    ];
    cli = await startCli(args, "(no environment)");
    const origin = `http://127.0.0.1:${port}`;
    expect(cli.output()).toContain("pairingUrl: https://pulse.example.test/pair#");
    expect(await (await fetch(origin)).text()).toBe("test client");
    const headers = await authenticate(origin, cli);
    for (const role of ["standard", "read-only", "admin"] as const) {
      const output = await new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          process.execPath,
          ["apps/server/src/bin.ts", "hub", "pair", "--base-dir", baseDir, "--role", role],
          { cwd, timeout: 15_000 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      const pairingUrl = /Pairing URL: (\S+)/.exec(output)?.[1];
      if (!pairingUrl) throw new Error("CLI did not print a pairing URL");
      expect(new URL(pairingUrl).origin).toBe("https://pulse.example.test");
      const credential = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const paired = await fetch(`${origin}/hub/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://pulse.example.test" },
        body: JSON.stringify({ credential }),
      });
      expect(paired.status).toBe(200);
      expect(paired.headers.get("set-cookie")).toContain("; Secure");
      const { token } = (await paired.json()) as { token: string };
      const session = await fetch(`${origin}/hub/auth/session`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(decodeRole(await session.json()).role).toBe(role);
    }
    expect(await (await fetch(`${origin}/hub/environments`, { headers })).json()).toEqual({
      environments: [],
    });
    expect(await (await fetch(`${origin}/hub/connection`)).json()).toEqual({
      hubUrl: null,
      localHubAvailable: true,
      localEnvironmentAvailable: false,
      localDaemonAvailable: false,
    });
    expect((await fetch(`${origin}/hub/auth/open`, { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/hub/auth/client-access`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json", origin: "https://evil.test" },
          body: JSON.stringify({ requirePairing: false }),
        })
      ).status,
    ).toBe(403);
    const changeAccess = (requirePairing: boolean) =>
      fetch(`${origin}/hub/local-auth/client-access`, {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/json",
          origin: "https://pulse.example.test",
        },
        body: JSON.stringify({ requirePairing }),
      });
    expect((await changeAccess(false)).status).toBe(200);
    await cli.stop();
    cli = await startCli(args, "(no environment)");
    expect(await (await fetch(`${origin}/hub/auth/client-access`)).json()).toEqual({
      requirePairing: false,
    });
    const opened = await fetch(`${origin}/hub/auth/open`, {
      method: "POST",
      headers: { origin: "https://pulse.example.test" },
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toContain("; Secure");
    const cookie = opened.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing pairing-free client cookie");
    expect(decodeRole(await opened.json()).role).toBe("admin");
    expect((await fetch(`${origin}/hub/environments`, { headers: { cookie } })).status).toBe(200);
    expect((await changeAccess(true)).status).toBe(200);
    expect((await fetch(`${origin}/hub/environments`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${origin}/hub/auth/open`, { method: "POST" })).status).toBe(401);
    await expect(
      NodeFSP.stat(NodePath.join(baseDir, "userdata", "statev2.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cli?.stop();
    await close(web);
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
}, 30_000);

it("serves a client through its own origin while a transport-only hub serves no client", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-client-only-"));
  const web = NodeHttp.createServer((_request, response) => response.end("client client"));
  const webPort = await listen(web);
  const hubProbe = NodeHttp.createServer();
  const hubPort = await listen(hubProbe);
  await close(hubProbe);
  const clientProbe = NodeHttp.createServer();
  const clientPort = await listen(clientProbe);
  await close(clientProbe);
  let hub: Awaited<ReturnType<typeof startCli>> | undefined;
  let client: Awaited<ReturnType<typeof startCli>> | undefined;
  try {
    hub = await startCli(
      ["hub", "--port", String(hubPort), "--base-dir", NodePath.join(baseDir, "hub-host")],
      "Hub: http://",
    );
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    expect((await fetch(hubOrigin)).status).toBe(404);
    expect((await fetch(`${hubOrigin}/hub/auth/open`, { method: "POST" })).status).toBe(404);
    client = await startCli(
      [
        "client",
        "--hub",
        hubOrigin,
        "--port",
        String(clientPort),
        "--base-dir",
        baseDir,
        "--dev-url",
        `http://127.0.0.1:${webPort}`,
      ],
      "(no environment)",
    );
    const origin = `http://127.0.0.1:${clientPort}`;
    expect(await (await fetch(origin)).text()).toBe("client client");
    expect((await fetch(`${origin}/hub/auth/open`, { method: "POST" })).status).toBe(404);
    const headers = await authenticate(origin, hub, false);
    expect(await (await fetch(`${origin}/hub/environments`, { headers })).json()).toEqual({
      environments: [],
    });
    expect(await (await fetch(`${origin}/hub/connection`)).json()).toEqual({
      hubUrl: hubOrigin,
      localHubAvailable: false,
      localEnvironmentAvailable: false,
      localDaemonAvailable: false,
    });
    const ownerHeaders = await authenticate(origin, client);
    expect(
      decodeRole(
        await (await fetch(`${origin}/hub/local-auth/session`, { headers: ownerHeaders })).json(),
      ).role,
    ).toBe("admin");
    expect(
      (
        await fetch(`${origin}/hub/connection`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ hubUrl: hubOrigin }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/hub/connection`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...ownerHeaders },
          body: JSON.stringify({ hubUrl: hubOrigin }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${origin}/hub/connection`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...ownerHeaders },
          body: JSON.stringify({ hubUrl: null }),
        })
      ).status,
    ).toBe(400);
    await expect(
      NodeFSP.stat(NodePath.join(baseDir, "userdata", "statev2.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client?.stop();
    await hub?.stop();
    await close(web);
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
}, 30_000);

it.each(["browser", "desktop"] as const)(
  "%s toggles a hosted environment live without moving headless execution and persists its choice",
  async (mode) => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pulse-desktop-client-hub-"),
    );
    const web = NodeHttp.createServer((_request, response) => response.end("desktop client"));
    const webPort = await listen(web);
    const reservePort = async () => {
      const probe = NodeHttp.createServer();
      const port = await listen(probe);
      await close(probe);
      return port;
    };
    const port = await reservePort();
    const destinationPort = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const destinationOrigin = `http://127.0.0.1:${destinationPort}`;
    const secret = "isolated-client-hub-desktop-secret";
    const desktopToken = currentDesktopBootstrapToken(secret, Date.now());
    const bootstrap: DesktopBackendBootstrap | undefined =
      mode === "desktop"
        ? {
            mode: "desktop",
            noBrowser: true,
            port,
            host: "127.0.0.1",
            t3Home: baseDir,
            desktopBootstrapToken: desktopToken,
            desktopBootstrapSecret: secret,
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          }
        : undefined;
    const args = [
      "serve",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--dev-url",
      `http://127.0.0.1:${webPort}`,
    ];
    let cli: Awaited<ReturnType<typeof startCli>> | undefined;
    let destination: Awaited<ReturnType<typeof startCli>> | undefined;
    try {
      destination = await startCli(
        [
          "serve",
          "--port",
          String(destinationPort),
          "--base-dir",
          NodePath.join(baseDir, "headless"),
        ],
        `T3 Code: ${destinationOrigin}`,
      );
      const destinationHeaders = await authenticate(destinationOrigin, destination);
      const readDestinationCatalog = async () =>
        decodeCatalog(
          await (
            await fetch(`${destinationOrigin}/hub/environments`, { headers: destinationHeaders })
          ).json(),
        );
      const original = await readDestinationCatalog();
      expect(original.environments).toHaveLength(1);
      expect(original.environments[0]?.connected).toBe(true);
      const createCredential = async (path: string, input: object) => {
        const response = await fetch(`${destinationOrigin}/hub/auth/${path}`, {
          method: "POST",
          headers: { ...destinationHeaders, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(200);
        return decodeCredential(await response.json()).credential;
      };
      cli = await startCli([...args, "--no-environment"], "(no environment)", bootstrap);
      expect(await (await fetch(origin)).text()).toBe("desktop client");
      expect(await (await fetch(`${origin}/hub/connection`)).json()).toMatchObject({
        hubUrl: null,
        localHubAvailable: true,
        localEnvironmentAvailable: false,
      });
      let headers =
        mode === "desktop"
          ? await authenticateCredential(origin, desktopToken)
          : await authenticate(origin, cli);
      const ownedEnvironment = decodeLocalEnvironment(
        await (await fetch(`${origin}/hub/local-environment`)).json(),
      );
      expect(ownedEnvironment.environmentId).toBeTypeOf("string");
      expect(ownedEnvironment.label).toBeTypeOf("string");
      const setEnabled = async (enabled: boolean) => {
        const response = await fetch(`${origin}/hub/local-environment`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json", origin },
          body: JSON.stringify({ enabled }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          supported: true,
          enabled,
          environmentId: ownedEnvironment.environmentId,
          label: ownedEnvironment.label,
        });
        expect(await (await fetch(origin)).text()).toBe("desktop client");
      };
      expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
        supported: true,
        enabled: false,
      });
      expect(
        (
          await fetch(`${origin}/hub/local-environment`, {
            method: "PUT",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ enabled: true }),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${origin}/hub/local-environment`, {
            method: "PUT",
            headers: {
              ...headers,
              "content-type": "application/json",
              origin: "https://other.example.test",
            },
            body: JSON.stringify({ enabled: true }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${origin}/hub/local-environment`, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json", origin },
            body: JSON.stringify({ enabled: "true" }),
          })
        ).status,
      ).toBe(400);
      for (const role of ["standard", "read-only"] as const) {
        const issued = await fetch(`${origin}/hub/auth/pairing`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", origin },
          body: JSON.stringify({ role, ttlMinutes: 10 }),
        });
        const credential = decodeCredential(await issued.json()).credential;
        const restricted = await authenticateCredential(origin, credential);
        expect(
          (
            await fetch(`${origin}/hub/local-environment`, {
              method: "PUT",
              headers: { ...restricted, "content-type": "application/json", origin },
              body: JSON.stringify({ enabled: true }),
            })
          ).status,
        ).toBe(403);
      }
      await expect(
        NodeFSP.stat(NodePath.join(baseDir, "userdata", "statev2.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      // A failed persistence write rolls the execution change back without taking down the hub.
      const pendingSetting = NodePath.join(baseDir, "userdata", "hub-local-environment.json.tmp");
      await NodeFSP.mkdir(pendingSetting);
      expect(
        (
          await fetch(`${origin}/hub/local-environment`, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json", origin },
            body: JSON.stringify({ enabled: true }),
          })
        ).status,
      ).toBe(400);
      expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
        supported: true,
        enabled: false,
      });
      expect(await (await fetch(origin)).text()).toBe("desktop client");
      await NodeFSP.rm(pendingSetting, { recursive: true });
      await setEnabled(true);
      const running = decodeCatalog(
        await (await fetch(`${origin}/hub/environments`, { headers })).json(),
      );
      expect(running.environments).toHaveLength(1);
      expect(running.environments[0]?.environmentId).toBe(ownedEnvironment.environmentId);
      expect(running.environments[0]?.connected).toBe(true);
      await setEnabled(false);
      await setEnabled(false); // Idempotent stop leaves the host alive.
      expect(
        decodeCatalog(await (await fetch(`${origin}/hub/environments`, { headers })).json())
          .environments[0]?.connected,
      ).toBe(false);
      await setEnabled(true);
      expect(
        decodeCatalog(await (await fetch(`${origin}/hub/environments`, { headers })).json()),
      ).toEqual(running);
      await setEnabled(false);
      const moved = await fetch(`${origin}/hub/connection`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json", origin },
        body: JSON.stringify({
          hubUrl: destinationOrigin,
          pairingCode: await createCredential("pairing", { role: "admin", ttlMinutes: 10 }),
        }),
      });
      expect(moved.status).toBe(200);
      const cookie = moved.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("Missing paired client cookie");
      expect(
        decodeCatalog(
          await (await fetch(`${origin}/hub/environments`, { headers: { cookie } })).json(),
        ),
      ).toEqual(original);
      await cli.stop();
      cli = await startCli([...args, "--no-environment"], "(no environment)", bootstrap);
      expect(await (await fetch(`${origin}/hub/connection`)).json()).toMatchObject({
        hubUrl: destinationOrigin,
        localEnvironmentAvailable: false,
      });
      headers =
        mode === "desktop"
          ? await authenticateCredential(origin, desktopToken)
          : await authenticate(origin, cli);
      const restored = await fetch(`${origin}/hub/connection`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json", origin },
        body: JSON.stringify({ hubUrl: null }),
      });
      expect(restored.status).toBe(200);
      expect(await readDestinationCatalog()).toEqual(original);
      expect(
        (await NodeFSP.stat(NodePath.join(baseDir, "userdata", "statev2.sqlite"))).isFile(),
      ).toBe(true);
      const rejoined = await fetch(`${origin}/hub/connection`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json", origin },
        body: JSON.stringify({
          hubUrl: destinationOrigin,
          pairingCode: await createCredential("pairing", { role: "admin", ttlMinutes: 10 }),
        }),
      });
      expect(rejoined.status).toBe(200);
      // Starting execution retains the owned hub while the client uses the remote hub.
      await setEnabled(true);
      expect(await (await fetch(origin)).text()).toBe("desktop client");
      expect(await readDestinationCatalog()).toEqual(original);
      expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
        enabled: true,
        hubUrl: null,
      });
      const enrolled = await fetch(`${origin}/hub/local-environment/connection`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json", origin },
        body: JSON.stringify({
          hubUrl: destinationOrigin,
          environmentInvitation: await createCredential("invitations", { label: "Desktop" }),
        }),
      });
      expect(enrolled.status).toBe(200);
      const joined = await readDestinationCatalog();
      expect(joined.environments).toHaveLength(2);
      expect(joined.environments).toEqual(expect.arrayContaining([...original.environments]));
      expect(joined.environments.every((environment) => environment.connected)).toBe(true);
      await setEnabled(false);
      const stopped = await readDestinationCatalog();
      expect(stopped.environments).toEqual(expect.arrayContaining([...original.environments]));
      expect(stopped.environments.filter((environment) => environment.connected)).toEqual(
        original.environments,
      );
      await setEnabled(true);
      expect(await readDestinationCatalog()).toEqual(joined);
      await setEnabled(false);
      await cli.stop();
      // A saved choice overrides the startup default on the next normal serve.
      cli = await startCli(args, "(no environment)", bootstrap);
      expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
        supported: true,
        enabled: false,
      });
      expect(await readDestinationCatalog()).toEqual(stopped);
    } finally {
      await cli?.stop();
      await destination?.stop();
      await close(web);
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
  60_000,
);

it.each(["serve", "desktop"] as const)(
  "%s starts and registers a local environment without a hub flag",
  async (mode) => {
    const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-serve-complete-"));
    const web = NodeHttp.createServer((_request, response) => response.end("complete client"));
    const webPort = await listen(web);
    const probe = NodeHttp.createServer();
    const port = await listen(probe);
    await close(probe);
    let cli: Awaited<ReturnType<typeof startCli>> | undefined;
    let destination: Awaited<ReturnType<typeof startCli>> | undefined;
    const desktopSecret = "isolated-desktop-test-secret";
    const desktopToken = currentDesktopBootstrapToken(desktopSecret, Date.now());
    const bootstrap: DesktopBackendBootstrap | undefined =
      mode === "desktop"
        ? {
            mode: "desktop",
            noBrowser: true,
            port,
            t3Home: baseDir,
            host: "127.0.0.1",
            desktopBootstrapToken: desktopToken,
            desktopBootstrapSecret: desktopSecret,
            tailscaleServeEnabled: false,
            tailscaleServePort: 443,
          }
        : undefined;
    try {
      const args = [
        "serve",
        "--port",
        String(port),
        "--base-dir",
        baseDir,
        "--dev-url",
        `http://127.0.0.1:${webPort}`,
      ];
      cli = await startCli(args, `T3 Code: http://127.0.0.1:${port}`, bootstrap);
      const origin = `http://127.0.0.1:${port}`;
      const headers =
        mode === "desktop"
          ? await authenticateCredential(origin, desktopToken)
          : await authenticate(origin, cli);
      const catalog = decodeCatalog(
        await (await fetch(`${origin}/hub/environments`, { headers })).json(),
      );
      expect(catalog.environments).toHaveLength(1);
      const environment = catalog.environments[0];
      if (!environment) throw new Error("Local environment was not registered");
      expect(environment.connected).toBe(true);
      const descriptor = decodeDescriptor(
        await (
          await fetch(
            `${origin}/hub/environments/${environment.environmentId}/.well-known/t3/environment`,
            { headers },
          )
        ).json(),
      );
      expect(descriptor.environmentId).toBe(environment.environmentId);
      const access = decodeAccess(
        await (await fetch(`${origin}/hub/auth/access`, { headers })).json(),
      );
      expect(access.clients).toHaveLength(1);
      expect(access.clients[0]?.role).toBe("admin");
      expect(access.environments?.[0]?.environmentId).toBe(environment.environmentId);
      expect(access.daemons).toEqual(access.environments);
      expect(await (await fetch(origin)).text()).toBe("complete client");
      expect(
        (await NodeFSP.stat(NodePath.join(baseDir, "userdata", "statev2.sqlite"))).isFile(),
      ).toBe(true);
      if (mode === "desktop") {
        const destinationProbe = NodeHttp.createServer();
        const destinationPort = await listen(destinationProbe);
        await close(destinationProbe);
        const destinationOrigin = `http://127.0.0.1:${destinationPort}`;
        destination = await startCli(
          [
            "hub",
            "--port",
            String(destinationPort),
            "--base-dir",
            NodePath.join(baseDir, "destination"),
          ],
          "Hub pairing token:",
        );
        const destinationHeaders = await authenticate(destinationOrigin, destination, false);
        const createCredential = async (path: string, input: object) => {
          const response = await fetch(`${destinationOrigin}/hub/auth/${path}`, {
            method: "POST",
            headers: { ...destinationHeaders, "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          expect(response.status).toBe(200);
          return decodeCredential(await response.json()).credential;
        };
        const switchHub = async (input: object) => {
          const response = await fetch(`${origin}/hub/connection`, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json", origin },
            body: JSON.stringify(input),
          });
          expect(response.status).toBe(200);
          return response;
        };
        const moved = await switchHub({
          hubUrl: destinationOrigin,
          pairingCode: await createCredential("pairing", { role: "admin", ttlMinutes: 10 }),
          [mode === "desktop" ? "daemonInvitation" : "environmentInvitation"]:
            await createCredential("invitations", { label: "Desktop" }),
        });
        const cookie = moved.headers.get("set-cookie")?.split(";")[0];
        if (!cookie) throw new Error("Hub switch did not pair the renderer");
        const movedCatalog = decodeCatalog(
          await (await fetch(`${origin}/hub/environments`, { headers: { cookie } })).json(),
        );
        expect(movedCatalog.environments).toEqual([]);
        expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
          enabled: true,
          hubUrl: null,
          environmentId: environment.environmentId,
        });
        expect(await (await fetch(origin)).text()).toBe("complete client");
        await cli.stop();
        cli = await startCli(args, `T3 Code: http://127.0.0.1:${port}`, bootstrap);
        expect(await (await fetch(`${origin}/hub/connection`)).json()).toMatchObject({
          hubUrl: destinationOrigin,
          localEnvironmentAvailable: true,
          localDaemonAvailable: true,
        });
        const localSession = await authenticateCredential(origin, desktopToken);
        const restored = await fetch(`${origin}/hub/connection`, {
          method: "PUT",
          headers: { ...localSession, "content-type": "application/json", origin },
          body: JSON.stringify({ hubUrl: null }),
        });
        expect(restored.status).toBe(200);
        expect(
          decodeCatalog(
            await (await fetch(`${origin}/hub/environments`, { headers: localSession })).json(),
          ).environments,
        ).toEqual([{ ...environment, connected: true }]);
        const rejoined = await fetch(`${origin}/hub/connection`, {
          method: "PUT",
          headers: { ...localSession, "content-type": "application/json", origin },
          body: JSON.stringify({
            hubUrl: destinationOrigin,
            pairingCode: await createCredential("pairing", { role: "admin", ttlMinutes: 10 }),
          }),
        });
        expect(rejoined.status).toBe(200);
        const rejoinedCatalog = decodeCatalog(
          await (
            await fetch(`${destinationOrigin}/hub/environments`, { headers: destinationHeaders })
          ).json(),
        );
        expect(rejoinedCatalog.environments).toEqual([]);
        expect(await (await fetch(`${origin}/hub/local-environment`)).json()).toMatchObject({
          enabled: true,
          hubUrl: null,
        });
      }
    } finally {
      await cli?.stop();
      await destination?.stop();
      await close(web);
      await NodeFSP.rm(baseDir, { recursive: true, force: true });
    }
  },
  60_000,
);

it("moves hosted and headless environments independently and returns to the owned hub", async () => {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pulse-environment-move-"));
  const web = NodeHttp.createServer((_request, response) => response.end("move test client"));
  const webPort = await listen(web);
  const reservePort = async () => {
    const probe = NodeHttp.createServer();
    const port = await listen(probe);
    await close(probe);
    return port;
  };
  const sourcePort = await reservePort();
  const destinationPort = await reservePort();
  const environmentPort = await reservePort();
  const sourceOrigin = `http://127.0.0.1:${sourcePort}`;
  const destinationOrigin = `http://127.0.0.1:${destinationPort}`;
  const sourceDir = NodePath.join(baseDir, "source");
  const environmentDir = NodePath.join(baseDir, "headless");
  const sourceArgs = [
    "serve",
    "--port",
    String(sourcePort),
    "--base-dir",
    sourceDir,
    "--dev-url",
    `http://127.0.0.1:${webPort}`,
  ];
  let source: Awaited<ReturnType<typeof startCli>> | undefined;
  let destination: Awaited<ReturnType<typeof startCli>> | undefined;
  let environment: Awaited<ReturnType<typeof startCli>> | undefined;
  try {
    source = await startCli(sourceArgs, `T3 Code: ${sourceOrigin}`);
    destination = await startCli(
      [
        "hub",
        "--port",
        String(destinationPort),
        "--base-dir",
        NodePath.join(baseDir, "destination"),
      ],
      "Hub pairing token:",
    );
    let sourceHeaders = await authenticate(sourceOrigin, source);
    const destinationHeaders = await authenticate(destinationOrigin, destination, false);
    const issue = async (origin: string, headers: object, path: string, input: object = {}) => {
      const response = await fetch(`${origin}/hub/auth/${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      return decodeCredential(await response.json()).credential;
    };
    const catalog = async (origin: string, headers: object) =>
      decodeCatalog(await (await fetch(`${origin}/hub/environments`, { headers })).json())
        .environments;
    const hosted = (await catalog(sourceOrigin, sourceHeaders))[0];
    if (!hosted) throw new Error("Missing hosted environment");
    expect(hosted.moveSupported).toBe(true);
    const ownedEnvironment = decodeLocalEnvironment(
      await (await fetch(`${sourceOrigin}/hub/local-environment`)).json(),
    );
    expect(ownedEnvironment.environmentId).toBe(hosted.environmentId);
    const headlessArgs = [
      "environment",
      "--hub",
      sourceOrigin,
      "--port",
      String(environmentPort),
      "--base-dir",
      environmentDir,
      "--invitation",
      await issue(sourceOrigin, sourceHeaders, "invitations"),
    ];
    environment = await startCli(headlessArgs, " connecting to ");
    const headless = (await catalog(sourceOrigin, sourceHeaders)).find(
      (item) => item.environmentId !== hosted.environmentId,
    );
    if (!headless) throw new Error("Missing headless environment");
    const movePath = `${sourceOrigin}/hub/environments/${headless.environmentId}/connection`;
    const move = (path: string, headers: object, input: object) =>
      fetch(path, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    expect((await move(movePath, {}, { hubUrl: destinationOrigin })).status).toBe(401);
    for (const role of ["standard", "read-only"] as const) {
      const credential = await issue(sourceOrigin, sourceHeaders, "pairing", {
        role,
        ttlMinutes: 10,
      });
      const restricted = await authenticateCredential(sourceOrigin, credential);
      expect((await move(movePath, restricted, { hubUrl: destinationOrigin })).status).toBe(403);
      expect(
        (
          await move(`${sourceOrigin}/hub/local-environment/connection`, restricted, {
            hubUrl: null,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await move(
          movePath,
          { ...sourceHeaders, origin: "https://other.example" },
          { hubUrl: destinationOrigin },
        )
      ).status,
    ).toBe(403);
    expect((await move(movePath, sourceHeaders, { hubUrl: 42 })).status).toBe(400);
    expect((await move(movePath, sourceHeaders, { hubUrl: sourceOrigin })).status).toBe(400);
    expect(
      (
        await move(movePath, sourceHeaders, {
          hubUrl: destinationOrigin,
          environmentInvitation: "invalid",
        })
      ).status,
    ).toBe(400);
    expect((await catalog(sourceOrigin, sourceHeaders)).every((item) => item.connected)).toBe(true);
    const before = decodeDescriptor(
      await (await fetch(`http://127.0.0.1:${environmentPort}/.well-known/t3/environment`)).json(),
    );
    const pendingSelection = NodePath.join(
      environmentDir,
      "userdata",
      "hub-environment-connection.json.tmp",
    );
    await NodeFSP.mkdir(pendingSelection);
    const rejected = await move(movePath, sourceHeaders, {
      hubUrl: destinationOrigin,
      environmentInvitation: await issue(destinationOrigin, destinationHeaders, "invitations"),
    });
    expect(rejected.status).toBe(400);
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual(
      expect.arrayContaining([hosted, headless]),
    );
    expect(await catalog(destinationOrigin, destinationHeaders)).toEqual([]);
    await NodeFSP.rm(pendingSelection, { recursive: true });
    const response = await move(movePath, sourceHeaders, {
      hubUrl: destinationOrigin,
      environmentInvitation: await issue(destinationOrigin, destinationHeaders, "invitations"),
    });
    expect(response.status).toBe(200);
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual([hosted]);
    expect(await catalog(destinationOrigin, destinationHeaders)).toEqual([
      { ...headless, connected: true },
    ]);
    expect(await (await fetch(`${sourceOrigin}/hub/connection`)).json()).toMatchObject({
      hubUrl: null,
    });
    expect(
      decodeDescriptor(
        await (
          await fetch(
            `${destinationOrigin}/hub/environments/${headless.environmentId}/.well-known/t3/environment`,
            { headers: destinationHeaders },
          )
        ).json(),
      ),
    ).toEqual(before);
    // Saved environment selection outranks the original service's --hub and consumed invitation.
    await environment.stop();
    environment = await startCli(headlessArgs, " connecting to ");
    expect(await catalog(destinationOrigin, destinationHeaders)).toEqual([
      { ...headless, connected: true },
    ]);
    const transferHosted = async (path: string, headers: object) => {
      const result = await move(path, headers, {
        hubUrl: destinationOrigin,
        environmentInvitation: await issue(destinationOrigin, destinationHeaders, "invitations"),
      });
      expect(result.status).toBe(200);
    };
    await transferHosted(
      `${sourceOrigin}/hub/environments/${hosted.environmentId}/connection`,
      sourceHeaders,
    );
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual([]);
    expect(await (await fetch(`${sourceOrigin}/hub/local-environment`)).json()).toMatchObject({
      supported: true,
      enabled: true,
      hubUrl: destinationOrigin,
      environmentId: hosted.environmentId,
      label: ownedEnvironment.label,
    });
    const localMovePath = `${sourceOrigin}/hub/local-environment/connection`;
    expect((await move(localMovePath, sourceHeaders, { hubUrl: null })).status).toBe(200);
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual([hosted]);
    expect(await catalog(destinationOrigin, destinationHeaders)).toEqual([
      { ...headless, connected: true },
    ]);
    await transferHosted(localMovePath, sourceHeaders);
    // A client can follow a remote hub without transferring its independently selected environment.
    const switched = await move(`${sourceOrigin}/hub/connection`, sourceHeaders, {
      hubUrl: destinationOrigin,
      pairingCode: await issue(destinationOrigin, destinationHeaders, "pairing", {
        role: "admin",
        ttlMinutes: 10,
      }),
    });
    expect(switched.status).toBe(200);
    expect((await move(localMovePath, sourceHeaders, { hubUrl: null })).status).toBe(200);
    expect(await (await fetch(`${sourceOrigin}/hub/connection`)).json()).toMatchObject({
      hubUrl: destinationOrigin,
    });
    expect(await catalog(destinationOrigin, destinationHeaders)).toEqual([
      { ...headless, connected: true },
    ]);
    expect(await (await fetch(sourceOrigin)).text()).toBe("move test client");
    // Owned hub registration remains available while the client uses a remote hub.
    await source.stop();
    source = await startCli(sourceArgs, `T3 Code: ${sourceOrigin}`);
    sourceHeaders = await authenticate(sourceOrigin, source);
    expect(await (await fetch(`${sourceOrigin}/hub/local-environment`)).json()).toMatchObject({
      enabled: true,
      hubUrl: null,
    });
    expect(await (await fetch(`${sourceOrigin}/hub/connection`)).json()).toMatchObject({
      hubUrl: destinationOrigin,
    });
    expect(
      (await move(`${sourceOrigin}/hub/connection`, sourceHeaders, { hubUrl: null })).status,
    ).toBe(200);
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual([hosted]);
    // Returning while disabled changes the saved destination without starting execution.
    await transferHosted(localMovePath, sourceHeaders);
    const toggle = async (enabled: boolean) => {
      const result = await move(`${sourceOrigin}/hub/local-environment`, sourceHeaders, {
        enabled,
      });
      expect(result.status).toBe(200);
    };
    await toggle(false);
    expect((await move(localMovePath, sourceHeaders, { hubUrl: null })).status).toBe(200);
    expect(await (await fetch(`${sourceOrigin}/hub/local-environment`)).json()).toMatchObject({
      enabled: false,
      hubUrl: null,
      environmentId: hosted.environmentId,
      label: ownedEnvironment.label,
    });
    await toggle(true);
    expect(await catalog(sourceOrigin, sourceHeaders)).toEqual([hosted]);
  } finally {
    await environment?.stop();
    await source?.stop();
    await destination?.stop();
    await close(web);
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
}, 90_000);
