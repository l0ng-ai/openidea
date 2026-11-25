// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOGFOOD_APP_NAME,
  deferRestartArgs,
  dogfoodBuildEnv,
  dogfoodCliArgs,
  dogfoodPaths,
  dogfoodTauriConfig,
  generateDogfoodIcons,
  installDogfood,
  parseDogfoodArgs,
  runParallelTasks,
} from "./dogfood.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("dogfood local and all", () => {
  it("parses local and all arguments, including pnpm separator flags", () => {
    expect(parseDogfoodArgs(["local"])).toEqual({ action: "local", buildOnly: false });
    expect(parseDogfoodArgs(["local", "--build-only"])).toEqual({ action: "local", buildOnly: true });
    expect(parseDogfoodArgs(["local", "--", "--build-only"])).toEqual({ action: "local", buildOnly: true });
    expect(parseDogfoodArgs(["all", "--", "my-remote", "--build-only", "--restart", "--ssh-opt", "Port=2222"])).toEqual(
      {
        action: "all",
        buildOnly: true,
        remoteArgs: ["my-remote", "--restart", "--ssh-opt", "Port=2222"],
        remote: {
          remoteName: "my-remote",
          clean: false,
          installRust: false,
          restart: "always",
          sshOpts: ["Port=2222"],
        },
      },
    );
    expect(deferRestartArgs(["my-remote", "--restart", "--ssh-opt", "Port=2222"])).toEqual([
      "my-remote",
      "--ssh-opt",
      "Port=2222",
      "--no-restart",
    ]);
    expect(() => parseDogfoodArgs([])).toThrow(/Expected 'local' or 'all'/);
    expect(() => parseDogfoodArgs(["build"])).toThrow(/Expected 'local' or 'all'/);
    expect(() => parseDogfoodArgs(["local", "my-remote"])).toThrow(/Unexpected option/);
    expect(() => parseDogfoodArgs(["all"])).toThrow(/Usage: dogfood:all <remote_name>/);
    expect(() => parseDogfoodArgs(["all", "my-remote", "--clean"])).toThrow(/dogfood:remote <remote_name> --clean/);
  });

  it("runs parallel tasks concurrently, prefixes lines, and terminates siblings on failure", async () => {
    const out: string[] = [];
    const err: string[] = [];
    await runParallelTasks(
      [
        {
          label: "local",
          command: process.execPath,
          args: ["-e", 'process.stdout.write("step 1\\nstep "); setTimeout(() => process.stdout.write("2"), 40);'],
        },
        {
          label: "remote",
          command: process.execPath,
          args: ["-e", 'process.stderr.write("warn line\\n"); process.stdout.write("done\\n");'],
        },
      ],
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    expect(out).toContain("[local] step 1\n");
    expect(out).toContain("[local] step 2\n");
    expect(out).toContain("[remote] done\n");
    expect(err).toEqual(["[remote] warn line\n"]);

    const started = Date.now();
    await expect(
      runParallelTasks(
        [
          {
            label: "local",
            command: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10_000)"],
          },
          {
            label: "remote",
            command: process.execPath,
            args: ["-e", "setTimeout(() => process.exit(2), 50)"],
          },
        ],
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow(/\[remote\] exited with status 2/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("keeps the vanilla app identifier so settings, MCP, Skills and agent sessions are shared, without updates", () => {
    const baseConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as {
      identifier: string;
    };
    const override = dogfoodTauriConfig(DEFAULT_DOGFOOD_APP_NAME, ["../target/dogfood-icons/dogfood.icns"]);
    expect(baseConfig.identifier).toBe("ai.l0ng.openidea");
    expect("identifier" in override).toBe(false);
    expect(override).toEqual({
      productName: "openidea_dogfood",
      bundle: {
        createUpdaterArtifacts: false,
        icon: ["../target/dogfood-icons/dogfood.icns"],
      },
      plugins: {
        updater: { endpoints: [] },
      },
    });
  });

  it("uses fast release compilation defaults while respecting caller overrides", () => {
    expect(dogfoodBuildEnv({})).toEqual({
      CARGO_PROFILE_RELEASE_LTO: "off",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    });
    expect(dogfoodBuildEnv({ CARGO_PROFILE_RELEASE_LTO: "thin", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "4" })).toEqual({
      CARGO_PROFILE_RELEASE_LTO: "thin",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "4",
    });
  });

  it("resolves platform bundle arguments and install destinations", () => {
    expect(dogfoodCliArgs("openidea_dogfood", ["icon.icns"], "darwin").slice(0, 3)).toEqual([
      "build",
      "--bundles",
      "app",
    ]);
    expect(dogfoodCliArgs("openidea_dogfood", ["icon.ico"], "win32").slice(0, 2)).toEqual(["build", "--no-bundle"]);
    expect(dogfoodPaths(join("/repo", "target"), "openidea_dogfood", "darwin", {})).toEqual({
      bundlePath: join("/repo", "target", "release", "bundle", "macos", "openidea_dogfood.app"),
      installPath: join("/Applications", "openidea_dogfood.app"),
    });
    expect(
      dogfoodPaths(join("/repo", "target"), "openidea_dogfood", "darwin", {
        DOGFOOD_INSTALL_DIR: "/Users/me/Applications",
      }),
    ).toEqual({
      bundlePath: join("/repo", "target", "release", "bundle", "macos", "openidea_dogfood.app"),
      installPath: join("/Users/me/Applications", "openidea_dogfood.app"),
    });
  });

  it("keeps the dogfood source SVGs geometrically identical to the vanilla icons in grey", () => {
    const sourceDir = join(root, "src-tauri", "icons", "source");
    for (const [vanillaName, dogfoodName] of [
      ["openidea.svg", "openidea-dogfood.svg"],
      ["openidea-windows.svg", "openidea-dogfood-windows.svg"],
    ] as const) {
      const vanilla = readFileSync(join(sourceDir, vanillaName), "utf8");
      const dogfood = readFileSync(join(sourceDir, dogfoodName), "utf8");
      expect(dogfood).not.toContain("#D9582C");
      const recolored = vanilla
        .replaceAll('aria-label="OpenIDEA"', 'aria-label="OpenIDEA Dogfood"')
        .replaceAll("#EAE7E0", "#E6E7E9")
        .replaceAll("#D9582C", "#787B82")
        .replaceAll("#1B1A1A", "#1B1C1E");
      expect(dogfood).toBe(recolored);
    }
  });

  it("generates the dogfood icon bundle with a distinct macOS .icns name", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openidea-dogfood-icons-"));
    try {
      const iconPaths = generateDogfoodIcons(root, tempDir, "darwin");
      expect(iconPaths).toHaveLength(5);
      expect(iconPaths.some((p) => p.endsWith("/dogfood.icns"))).toBe(true);
      expect(existsSync(join(tempDir, "dogfood.icns"))).toBe(true);
      expect(existsSync(join(tempDir, "128x128@2x.png"))).toBe(true);
      expect(existsSync(join(tempDir, "icon.ico"))).toBe(true);
      const firstMtime = statSync(join(tempDir, "dogfood.icns")).mtimeMs;
      expect(generateDogfoodIcons(root, tempDir, "darwin")).toEqual(iconPaths);
      expect(statSync(join(tempDir, "dogfood.icns")).mtimeMs).toBe(firstMtime);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("installs a macOS .app bundle into DOGFOOD_INSTALL_DIR", () => {
    if (process.platform !== "darwin") return;
    const tempDir = mkdtempSync(join(tmpdir(), "openidea-dogfood-install-"));
    const prevInstallDir = process.env.DOGFOOD_INSTALL_DIR;
    try {
      const fakeRoot = join(tempDir, "repo");
      const fakeBundle = join(fakeRoot, "target", "release", "bundle", "macos", "openidea_dogfood.app");
      mkdirSync(join(fakeBundle, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(fakeBundle, "Contents", "MacOS", "openidea"), "#!/bin/sh\n");
      const destDir = join(tempDir, "Applications");
      process.env.DOGFOOD_INSTALL_DIR = destDir;
      installDogfood(fakeRoot, "openidea_dogfood", "darwin", join(fakeRoot, "target"));
      expect(existsSync(join(destDir, "openidea_dogfood.app", "Contents", "MacOS", "openidea"))).toBe(true);
    } finally {
      if (prevInstallDir === undefined) delete process.env.DOGFOOD_INSTALL_DIR;
      else process.env.DOGFOOD_INSTALL_DIR = prevInstallDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
