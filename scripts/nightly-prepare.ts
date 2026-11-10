/**
 * Prepares a nightly build's commit: `node scripts/nightly-prepare.ts 202611081417` sets the
 * version one patch above the current one, with that stamp as its prerelease number, in the
 * files `release:prepare` covers, and gives tauri.conf.json the nightly app's identity, so it
 * installs next to the stable app and updates from its own manifest. Prints the version.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoVersion, edit, parseVersion, setCargoVersion, setJsonVersion } from "./release-prepare.ts";

export const NIGHTLY_ENDPOINT = "https://github.com/l0ng-ai/openidea/releases/download/nightly/latest.json";

/** `0.1.40-nightly.202611081417` from `0.1.39`: always above the last stable version and the last nightly. */
export function nightlyVersion(current: string, stamp: string | undefined): string {
  if (!stamp || !/^[1-9]\d{11}$/.test(stamp)) throw new Error(`expected a YYYYMMDDHHMM stamp, got ${stamp}`);
  const [major, minor, patch] = parseVersion(current).split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}-nightly.${stamp}`;
}

/** MSI and RPM reject prerelease versions, so a nightly build leaves them out of its bundles. */
export function setNightlyIdentity(json: string): string {
  const conf = JSON.parse(json);
  conf.productName = "OpenIDEA Nightly";
  conf.identifier = "ai.l0ng.openidea.nightly";
  conf.bundle.targets = ["app", "dmg", "appimage", "deb", "nsis"];
  conf.plugins.updater.endpoints = [NIGHTLY_ENDPOINT];
  return `${JSON.stringify(conf, null, 2)}\n`;
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const version = nightlyVersion(cargoVersion(readFileSync(join(root, "Cargo.toml"), "utf8")), process.argv[2]);

  edit(join(root, "Cargo.toml"), (text) => setCargoVersion(text, version));
  edit(join(root, "package.json"), (text) => setJsonVersion(text, version));
  edit(join(root, "src-tauri/tauri.conf.json"), (text) => setNightlyIdentity(setJsonVersion(text, version)));
  const cargo = spawnSync("cargo", ["update", "--workspace"], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
  if (cargo.status !== 0) throw new Error("cargo update --workspace failed");
  console.log(version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`nightly-prepare: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
