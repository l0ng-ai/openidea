import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DOGFOOD_APP_NAME = "openidea_dogfood";

const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface DogfoodCommand {
  action: "build" | "install";
  skipBuild: boolean;
}

export interface DogfoodPaths {
  bundlePath: string;
  installPath: string;
}

export function parseDogfoodArgs(args: readonly string[]): DogfoodCommand {
  const filtered = args.filter((arg) => arg !== "--");
  const action = filtered[0];
  if (action !== "build" && action !== "install") {
    throw new Error(`Expected 'build' or 'install', got ${action ? `'${action}'` : "no command"}`);
  }
  let skipBuild = false;
  for (const flag of filtered.slice(1)) {
    if (action === "install" && flag === "--no-build") {
      skipBuild = true;
    } else {
      throw new Error(`Unexpected option '${flag}' for '${action}'`);
    }
  }
  return { action, skipBuild };
}

/**
 * Tauri config override for local dogfood builds.
 *
 * Keeps `identifier` untouched (`ai.l0ng.openidea` from `src-tauri/tauri.conf.json`) so the
 * dogfood app shares configuration, settings, WebView storage, MCP servers, Skills, agent
 * sessions, credentials, plugins and caches with the vanilla release app.
 *
 * Clears the updater endpoints: the next release would otherwise replace the dogfood bundle
 * with the official app.
 */
export function dogfoodTauriConfig(appName: string, iconPaths: readonly string[]) {
  return {
    productName: appName,
    bundle: {
      createUpdaterArtifacts: false,
      icon: [...iconPaths],
    },
    plugins: {
      updater: { endpoints: [] },
    },
  };
}

export function dogfoodBuildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CARGO_PROFILE_RELEASE_LTO: baseEnv.CARGO_PROFILE_RELEASE_LTO ?? "off",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: baseEnv.CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?? "16",
  };
}

export function dogfoodCliArgs(
  appName: string,
  iconPaths: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const config = JSON.stringify(dogfoodTauriConfig(appName, iconPaths));
  if (platform === "darwin") {
    return ["build", "--bundles", "app", "--config", config];
  }
  return ["build", "--no-bundle", "--config", config];
}

/** Cargo's target directory, which a `CARGO_TARGET_DIR` or `build.target-dir` setting can move. */
export function cargoTargetDir(root: string): string {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) {
    try {
      const dir = (JSON.parse(result.stdout) as { target_directory?: unknown }).target_directory;
      if (typeof dir === "string" && dir) return dir;
    } catch {
      // Fall back to the default below.
    }
  }
  return join(root, "target");
}

export function dogfoodPaths(
  targetDir: string,
  appName: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): DogfoodPaths {
  const customInstallPath = env.DOGFOOD_INSTALL_PATH?.trim();
  const customInstallDir = env.DOGFOOD_INSTALL_DIR?.trim();
  if (platform === "darwin") {
    return {
      bundlePath: join(targetDir, "release", "bundle", "macos", `${appName}.app`),
      installPath: customInstallPath || join(customInstallDir || "/Applications", `${appName}.app`),
    };
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return {
      bundlePath: join(targetDir, "release", "openidea.exe"),
      installPath: customInstallPath || join(customInstallDir || localAppData, appName),
    };
  }
  return {
    bundlePath: join(targetDir, "release", "openidea"),
    installPath: customInstallPath || join(customInstallDir || join(homedir(), ".local", "bin"), appName),
  };
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function runTauriIcon(root: string, cli: string, svgPath: string, outputDir: string) {
  const result = spawnSync(process.execPath, [cli, "icon", svgPath, "--output", outputDir], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dogfood icon generation failed (${result.status})`);
}

export function generateDogfoodIcons(
  root: string,
  outputDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const sourceDir = join(root, "src-tauri", "icons", "source");
  const svgPath = join(sourceDir, "openidea-dogfood.svg");
  const winSvgPath = join(sourceDir, "openidea-dogfood-windows.svg");
  const iconFiles = ["32x32.png", "128x128.png", "128x128@2x.png", "dogfood.icns", "icon.ico"];
  const stampPath = join(outputDir, ".source-sha256");
  const stamp = createHash("sha256")
    .update(platform)
    .update("\0")
    .update(readFileSync(svgPath))
    .update("\0")
    .update(readFileSync(winSvgPath))
    .digest("hex");

  // Preserve file mtimes/bytes when SVGs are unchanged so `tauri-build` does not re-link `src-tauri`.
  const upToDate =
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp &&
    iconFiles.every((file) => existsSync(join(outputDir, file)));

  if (!upToDate) {
    const require = createRequire(import.meta.url);
    const cli = require.resolve("@tauri-apps/cli/tauri.js");
    mkdirSync(outputDir, { recursive: true });
    runTauriIcon(root, cli, svgPath, outputDir);

    if (platform === "win32") {
      const winTemp = mkdtempSync(join(outputDir, "win-"));
      try {
        runTauriIcon(root, cli, winSvgPath, winTemp);
        copyFileSync(join(winTemp, "icon.ico"), join(outputDir, "icon.ico"));
      } finally {
        rmSync(winTemp, { recursive: true, force: true });
      }
    }

    // Distinct .icns filename avoids macOS LaunchServices icon-cache collisions with OpenIDEA.app.
    copyFileSync(join(outputDir, "icon.icns"), join(outputDir, "dogfood.icns"));
    writeFileSync(stampPath, `${stamp}\n`);
  }

  const tauriDir = join(root, "src-tauri");
  return iconFiles.map((file) => toPosixPath(relative(tauriDir, join(outputDir, file))));
}

function runChecked(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

export function buildDogfood(root: string, appName: string) {
  const iconsDir = join(root, "target", "dogfood-icons");
  const iconPaths = generateDogfoodIcons(root, iconsDir);
  const args = dogfoodCliArgs(appName, iconPaths);
  runChecked(process.execPath, [join(root, "scripts", "tauri.ts"), ...args], {
    cwd: root,
    env: dogfoodBuildEnv(),
  });
}

const SHARED_DATA_NOTES = [
  "The dogfood app shares its single instance with OpenIDEA: quit one before opening the other.",
  "It writes OpenIDEA's settings and data; a setting only newer builds know can make an older OpenIDEA ignore your settings file.",
  "It never updates itself: run 'pnpm dogfood:install' again to pick up new changes.",
];

export function installDogfood(
  root: string,
  appName: string,
  platform: NodeJS.Platform = process.platform,
  targetDir: string = cargoTargetDir(root),
) {
  const { bundlePath, installPath } = dogfoodPaths(targetDir, appName, platform);
  installBundle(root, appName, platform, bundlePath, installPath);
  for (const note of SHARED_DATA_NOTES) console.log(note);
}

function installBundle(
  root: string,
  appName: string,
  platform: NodeJS.Platform,
  bundlePath: string,
  installPath: string,
) {
  if (!existsSync(bundlePath)) {
    throw new Error(`Dogfood build output not found at ${bundlePath}; run 'mise run dogfood:build' first`);
  }

  if (platform === "darwin") {
    rmSync(installPath, { recursive: true, force: true });
    mkdirSync(dirname(installPath), { recursive: true });
    runChecked("cp", ["-R", bundlePath, installPath]);
    runChecked("xattr", ["-cr", installPath]);
    const now = new Date();
    utimesSync(installPath, now, now);
    if (existsSync(LSREGISTER_PATH)) {
      spawnSync(LSREGISTER_PATH, ["-f", installPath], { stdio: "ignore" });
    }
    console.log(`Installed ${appName} to ${installPath}`);
    return;
  }

  if (platform === "win32") {
    mkdirSync(installPath, { recursive: true });
    const targetExe = join(installPath, `${appName}.exe`);
    copyFileSync(bundlePath, targetExe);
    const webviewLoader = join(dirname(bundlePath), "WebView2Loader.dll");
    if (existsSync(webviewLoader)) {
      copyFileSync(webviewLoader, join(installPath, "WebView2Loader.dll"));
    }
    console.log(`Installed ${appName} to ${targetExe}`);
    return;
  }

  mkdirSync(dirname(installPath), { recursive: true });
  copyFileSync(bundlePath, installPath);
  chmodSync(installPath, 0o755);
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const iconSource = join(root, "target", "dogfood-icons", "128x128.png");
  if (existsSync(iconSource)) {
    const iconDest = join(dataHome, "icons", "hicolor", "128x128", "apps", `${appName}.png`);
    mkdirSync(dirname(iconDest), { recursive: true });
    copyFileSync(iconSource, iconDest);
  }
  const desktopFile = join(dataHome, "applications", `${appName}.desktop`);
  mkdirSync(dirname(desktopFile), { recursive: true });
  writeFileSync(
    desktopFile,
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${appName}`,
      `Exec=${installPath} %F`,
      `Icon=${appName}`,
      "Categories=Development;IDE;",
      "StartupWMClass=openidea",
      "",
    ].join("\n"),
  );
  console.log(`Installed ${appName} to ${installPath}`);
}

function main() {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const { action, skipBuild } = parseDogfoodArgs(process.argv.slice(2));
  const appName = process.env.DOGFOOD_APP_NAME?.trim() || DEFAULT_DOGFOOD_APP_NAME;
  if (action === "build" || !skipBuild) {
    buildDogfood(root, appName);
  }
  if (action === "install") {
    installDogfood(root, appName);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
