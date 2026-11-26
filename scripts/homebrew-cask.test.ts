// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dmgName, renderCask, stableVersion } from "./homebrew-cask.ts";

const ARM = "5fc404ab470bb9ca5168ab5d1769ad5892d657a8992fb26adf192f2c60bd8279";
const INTEL = "38b3b06bbbc46503889ab43f16131f87037d3499cac7792e9fc221bcaac0bc05";

describe("stableVersion", () => {
  it("takes the version of a stable tag", () => {
    expect(stableVersion("v0.1.51")).toBe("0.1.51");
  });

  it("skips prereleases and other refs", () => {
    expect(stableVersion("v0.2.0-beta.1")).toBeNull();
    expect(stableVersion("0.1.51")).toBeNull();
    expect(stableVersion("main")).toBeNull();
  });
});

describe("dmgName", () => {
  it("names the release's DMG of each arch", () => {
    expect(dmgName("0.1.51", "arm")).toBe("OpenIDEA_0.1.51_aarch64.dmg");
    expect(dmgName("0.1.51", "intel")).toBe("OpenIDEA_0.1.51_x64.dmg");
  });
});

describe("renderCask", () => {
  it("pins the version and the checksum of each arch", () => {
    const cask = renderCask("0.1.51", { arm: ARM, intel: INTEL });
    expect(cask).toContain(`version "0.1.51"`);
    expect(cask).toContain(`sha256 arm:   "${ARM}",\n         intel: "${INTEL}"`);
    expect(cask).toContain(
      `url "https://github.com/l0ng-ai/openidea/releases/download/v#{version}/OpenIDEA_#{version}_#{arch}.dmg"`,
    );
  });

  it("leaves updates to the app and installs the CLI", () => {
    const cask = renderCask("0.1.51", { arm: ARM, intel: INTEL });
    expect(cask).toContain("auto_updates true");
    expect(cask).toContain(`binary "#{appdir}/OpenIDEA.app/Contents/Resources/bin/openidea"`);
    expect(cask).toContain(`"~/Library/Application Support/ai.l0ng.openidea"`);
  });

  it("refuses a checksum that isn't SHA-256", () => {
    expect(() => renderCask("0.1.51", { arm: ARM, intel: "abc" })).toThrow(/intel/);
  });
});
