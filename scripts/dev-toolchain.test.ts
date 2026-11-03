// @vitest-environment node
import { describe, expect, it } from "vitest";
import { rustHost, withDevBuildDefaults } from "./dev-toolchain.ts";
import { withDevConfig } from "./dev-session.ts";

describe("desktop development startup", () => {
  it("rejects missing toolchain output with an actionable error", () => {
    expect(rustHost("rustc 1.99.0\r\nhost: x86_64-pc-windows-msvc\r\nLLVM version: 22\r\n")).toBe(
      "x86_64-pc-windows-msvc",
    );
    expect(() => rustHost("")).toThrow("available memory");
    expect(() => rustHost("rustc 1.99.0\nhost:\n")).toThrow("no host target");
    expect(() => rustHost("host:\nrelease: 1.99.0\n")).toThrow("no host target");
  });

  it("places Cargo defaults after Tauri config and before application arguments", () => {
    const args = withDevConfig(
      withDevBuildDefaults(["dev", "--config", "app.json", "--", "--", "D:/Games/My Game", "-j8"]),
      "http://localhost:1420/",
    );
    expect(args.slice(0, 4)).toEqual(["dev", "--config", "app.json", "--config"]);
    expect(args.slice(5)).toEqual([
      "--",
      "-j",
      "1",
      "--config",
      "profile.dev.package.openidea.debug=0",
      "--",
      "D:/Games/My Game",
      "-j8",
    ]);
  });

  it("preserves explicit build settings and works without runner arguments", () => {
    expect(withDevBuildDefaults(["dev"])).toEqual([
      "dev",
      "--",
      "-j",
      "1",
      "--config",
      "profile.dev.package.openidea.debug=0",
    ]);
    for (const jobs of [["-j", "2"], ["-j2"], ["--jobs=2"], ["--jobs", "2"]]) {
      const runner = [...jobs, "--config", "profile.dev.package.openidea.debug=1"];
      expect(withDevBuildDefaults(["dev", "--", ...runner])).toEqual([
        "dev",
        "--",
        "--config",
        "profile.dev.package.openidea.debug=0",
        ...runner,
      ]);
    }
  });
});
