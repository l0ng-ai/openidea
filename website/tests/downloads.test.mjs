import assert from "node:assert/strict";
import test from "node:test";
import { detectDesktopPlatform, buildDownloadManifest } from "../src/lib/downloads.mjs";

test("detects desktop platforms without guessing mobile devices are desktops", () => {
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "macos");
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (X11; Linux x86_64)"), "linux");
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (Linux; Android 15)"), null);
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), null);
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), null);
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (X11; CrOS x86_64)"), null);
  assert.equal(detectDesktopPlatform("Mozilla/5.0 (X11; FreeBSD amd64)"), null);
  assert.equal(detectDesktopPlatform(""), null);
});

function release(names) {
  return {
    tag_name: "v0.1.24",
    html_url: "https://github.com/l0ng-ai/openidea/releases/tag/v0.1.24",
    assets: names.map((name) => ({
      name,
      size: 1234,
      browser_download_url: `https://github.com/l0ng-ai/openidea/releases/download/v0.1.24/${name}`,
    })),
  };
}

test("maps real installer assets to platform-specific direct downloads", () => {
  const result = buildDownloadManifest(
    release([
      "OpenIDEA_0.1.24_aarch64.dmg",
      "OpenIDEA_0.1.24_x64.dmg",
      "OpenIDEA_0.1.24_x64-setup.exe",
      "OpenIDEA_0.1.24_x64_en-US.msi",
      "OpenIDEA_0.1.24_amd64.AppImage",
      "OpenIDEA_0.1.24_amd64.deb",
      "OpenIDEA-0.1.24-1.x86_64.rpm",
      "OpenIDEA_0.1.24_amd64.AppImage.sig",
      "openidea-server-linux-aarch64.gz",
      "latest.json",
    ]),
  );
  assert.equal(result.version, "0.1.24");
  assert.deepEqual(
    result.packages.macos.map((p) => p.label),
    ["Apple Silicon", "Intel"],
  );
  assert.deepEqual(
    result.packages.windows.map((p) => p.format),
    ["EXE", "MSI"],
  );
  assert.deepEqual(
    result.packages.linux.map((p) => p.format),
    ["AppImage", "DEB", "RPM"],
  );
  assert.ok(result.packages.macos[0].url.endsWith("/OpenIDEA_0.1.24_aarch64.dmg"));
  assert.equal(Object.values(result.packages).flat().length, 7);
});

test("does not invent download links for missing platform packages", () => {
  const result = buildDownloadManifest(release(["OpenIDEA_0.1.24_aarch64.dmg"]));
  assert.deepEqual(result.packages.windows, []);
  assert.deepEqual(result.packages.linux, []);
});

test("rejects draft or prerelease data and untrusted installer destinations", () => {
  const data = release(["OpenIDEA_0.1.24_aarch64.dmg"]);
  assert.throws(() => buildDownloadManifest({ ...data, draft: true }), /stable/i);
  assert.throws(() => buildDownloadManifest({ ...data, prerelease: true }), /stable/i);
  data.assets[0].browser_download_url = "https://example.com/installer.dmg";
  assert.throws(() => buildDownloadManifest(data), /download URL/i);
});
