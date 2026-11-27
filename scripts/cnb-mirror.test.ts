// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KEEP, mirrorManifest, releasesToPrune } from "./cnb-mirror.ts";

describe("mirrorManifest", () => {
  const gh = "https://github.com/l0ng-ai/openidea/releases/download/v0.1.38";
  const manifest = {
    version: "0.1.38",
    notes: "",
    pub_date: "2026-11-06T00:00:00Z",
    platforms: {
      "darwin-aarch64": { signature: "sig-mac", url: `${gh}/OpenIDEA_aarch64.app.tar.gz` },
      "windows-x86_64-nsis": { signature: "sig-win", url: `${gh}/OpenIDEA_0.1.38_x64-setup.exe` },
      "windows-x86_64-portable": {
        signature: "sig-portable",
        url: `${gh}/OpenIDEA_0.1.38_windows_x64_portable.zip`,
      },
      "windows-aarch64-portable": {
        signature: "sig-portable-arm",
        url: `${gh}/OpenIDEA_0.1.38_windows_arm64_portable.zip`,
      },
    },
  };

  it("points every bundle at the CNB release and keeps the signatures", () => {
    const cnb = "https://cnb.cool/l0ng-ai/openidea/-/releases/download/v0.1.38";
    expect(mirrorManifest(manifest, "v0.1.38")).toEqual({
      ...manifest,
      platforms: {
        "darwin-aarch64": { signature: "sig-mac", url: `${cnb}/OpenIDEA_aarch64.app.tar.gz` },
        "windows-x86_64-nsis": { signature: "sig-win", url: `${cnb}/OpenIDEA_0.1.38_x64-setup.exe` },
        "windows-x86_64-portable": {
          signature: "sig-portable",
          url: `${cnb}/OpenIDEA_0.1.38_windows_x64_portable.zip`,
        },
        "windows-aarch64-portable": {
          signature: "sig-portable-arm",
          url: `${cnb}/OpenIDEA_0.1.38_windows_arm64_portable.zip`,
        },
      },
    });
  });

  it("refuses a manifest of another release", () => {
    expect(() => mirrorManifest(manifest, "v0.1.39")).toThrow(/darwin-aarch64/);
  });
});

describe("releasesToPrune", () => {
  const release = (n: number) => ({
    id: String(n),
    tag_name: `v0.1.${n}`,
    created_at: `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`,
  });

  it("keeps the newest releases and removes the rest", () => {
    const releases = Array.from({ length: KEEP + 3 }, (_, i) => release(i + 1)).reverse();
    expect(releasesToPrune(releases, `v0.1.${KEEP + 3}`).map((r) => r.tag_name)).toEqual([
      "v0.1.3",
      "v0.1.2",
      "v0.1.1",
    ]);
  });

  it("removes nothing within the limit, and never the release being mirrored", () => {
    expect(releasesToPrune([release(1), release(2)], "v0.1.2")).toEqual([]);
    // A rerun for an old tag: it is the oldest, but it was just uploaded.
    expect(releasesToPrune([release(1), release(2), release(3)], "v0.1.1", 2)).toEqual([]);
  });
});
