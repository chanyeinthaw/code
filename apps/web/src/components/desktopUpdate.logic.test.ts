import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@satslab/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  getManualDesktopUpdateVersion,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it.each([
    "owner/repo/extra",
    "owner#notes/repo",
    "owner/repo#notes",
    "owner?tab=notes/repo",
    "owner/repo?tab=notes",
  ])("falls back to the Sora repository for an invalid configured repository: %s", (repository) => {
    expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
      "https://github.com/satslab/sora/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
      "https://github.com/satslab/sora/releases/tag/v1.2.3",
    );
  });
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("getManualDesktopUpdateVersion", () => {
  const manual = (currentVersion: string, latestVersion: string | null, updaterEnabled = false) =>
    getManualDesktopUpdateVersion({ updaterEnabled, currentVersion, latestVersion });

  it("offers a newer release when the updater is disabled", () => {
    expect(manual("1.0.0", "1.0.1")).toBe("1.0.1");
    expect(manual("1.0.0-nightly.20260101.1", "1.0.0-nightly.20260102.1")).toBe(
      "1.0.0-nightly.20260102.1",
    );
  });

  it("stays hidden when current, ahead, unknown, or handled by the updater", () => {
    expect(manual("1.0.1", "1.0.1")).toBeNull();
    expect(manual("1.0.2", "1.0.1")).toBeNull();
    expect(manual("1.0.0", null)).toBeNull();
    expect(manual("1.0.0", "1.0.1", true)).toBeNull();
  });
});
