// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NIGHTLY_ENDPOINT, nightlyVersion, setNightlyIdentity } from "./nightly-prepare.ts";

describe("nightlyVersion", () => {
  it("is one patch above the current version, numbered by its stamp", () => {
    expect(nightlyVersion("0.1.39", "202611081417")).toBe("0.1.40-nightly.202611081417");
  });

  it.each([undefined, "", "2026", "012611081417", "20261108141a"])("rejects the stamp %s", (stamp) => {
    expect(() => nightlyVersion("0.1.39", stamp)).toThrow("stamp");
  });

  it("rejects a current version that is not a release version", () => {
    expect(() => nightlyVersion("0.1.40-nightly.202611081417", "202611081417")).toThrow("expected a version");
  });
});

describe("setNightlyIdentity", () => {
  const conf = JSON.parse(setNightlyIdentity(readFileSync("src-tauri/tauri.conf.json", "utf8")));

  it("is an app of its own that updates from the nightly manifest", () => {
    expect(conf.productName).toBe("OpenIDEA Nightly");
    expect(conf.identifier).toBe("ai.l0ng.openidea.nightly");
    expect(conf.plugins.updater.endpoints).toEqual([NIGHTLY_ENDPOINT]);
  });

  it("leaves out the bundles that reject prerelease versions", () => {
    expect(conf.bundle.targets).not.toContain("msi");
    expect(conf.bundle.targets).not.toContain("rpm");
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
  });
});
