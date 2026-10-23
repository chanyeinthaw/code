import { cliReleaseTagUrl } from "@satslab/shared/cliRelease";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cliReleasePublishedAtom, latestCliReleaseAtom } from "./cliRelease";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("cliReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  // Servers download the GitHub release, so that is the publication a server update waits for.
  it("checks the GitHub release without tracing headers, so the browser skips the preflight", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ tag_name: `v${version}`, draft: false }),
    );

    const result = await settledCheck(cliReleasePublishedAtom(version));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(cliReleaseTagUrl(version));
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("treats an unpublished release as not ready", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));

    const result = await settledCheck(cliReleasePublishedAtom(version));

    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });

  // regression: #18709 update-everything skipped npm-installed servers
  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck(cliReleasePublishedAtom(version));

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });

  it("discovers server updates independently of the desktop updater", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json([
        { tag_name: "v0.0.5", draft: true },
        { tag_name: "v0.0.5-nightly.20261023.1", draft: false },
        { tag_name: "v0.0.4", draft: false },
      ]),
    );
    const result = await settledCheck(latestCliReleaseAtom("stable"));
    expect(AsyncResult.getOrElse(result, () => null)).toBe("0.0.4");
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      "https://api.github.com/repos/satslab/sora/releases?per_page=100&page=1",
    );
    expect(request.headers.get("traceparent")).toBeNull();
  });
});
