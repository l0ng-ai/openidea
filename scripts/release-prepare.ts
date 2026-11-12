/**
 * Prepares the release commit: `pnpm release:prepare 0.1.38` sets the app version in
 * Cargo.toml, package.json and src-tauri/tauri.conf.json, refreshes Cargo.lock, and,
 * when wit/ carries a newer plugin API than the released snapshot, copies wit/*.wit
 * over sdk/rust/openidea-plugin/tests/api/released/ (the release workflow refuses a
 * tag whose wit/ and snapshot versions differ). Commit the result as `chore: v<version>`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SNAPSHOT = "sdk/rust/openidea-plugin/tests/api/released";

/** `0.1.38` from `0.1.38` or `v0.1.38`; throws for anything else. */
export function parseVersion(arg: string | undefined): string {
  const version = arg?.replace(/^v/, "");
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`expected a version like 0.1.38, got ${arg}`);
  return version;
}

function compare(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
}

/** The line index and value of `version` in `[workspace.package]`. */
function workspaceVersionLine(lines: string[]): { index: number; version: string } {
  const start = lines.findIndex((line) => line.trim() === "[workspace.package]");
  for (let i = start + 1; start >= 0 && i < lines.length && !lines[i]!.startsWith("["); i++) {
    const match = /^version = "([^"]+)"$/.exec(lines[i]!.trim());
    if (match) return { index: i, version: match[1]! };
  }
  throw new Error("Cargo.toml: no version in [workspace.package]");
}

export function cargoVersion(toml: string): string {
  return workspaceVersionLine(toml.split("\n")).version;
}

export function setCargoVersion(toml: string, version: string): string {
  const lines = toml.split("\n");
  const { index } = workspaceVersionLine(lines);
  lines[index] = `version = "${version}"`;
  return lines.join("\n");
}

/** Replaces the top-level `"version"` of a JSON file, keeping its formatting. */
export function setJsonVersion(json: string, version: string): string {
  const current = (JSON.parse(json) as { version?: unknown }).version;
  if (typeof current !== "string") throw new Error("no top-level version");
  return json.replace(`"version": "${current}"`, `"version": "${version}"`);
}

/** `1.2.0` from a `package openidea:plugin@1.2.0;` line. */
export function apiVersion(wit: string): string {
  const match = /^package openidea:plugin@([^;]+);$/m.exec(wit);
  if (!match) throw new Error("no `package openidea:plugin@…;` line");
  return match[1]!;
}

/**
 * Copies `wit/*.wit` over the snapshot when wit/ declares another API version, and
 * returns the versions; leaves the snapshot alone otherwise (no API change to release).
 */
export function syncApiSnapshot(root: string): { from: string; to: string; copied: boolean } {
  const wit = join(root, "wit");
  const snapshot = join(root, SNAPSHOT);
  const to = apiVersion(readFileSync(join(wit, "plugin.wit"), "utf8"));
  const from = apiVersion(readFileSync(join(snapshot, "plugin.wit"), "utf8"));
  if (from === to) return { from, to, copied: false };
  for (const file of readdirSync(snapshot)) if (file.endsWith(".wit")) rmSync(join(snapshot, file));
  for (const file of readdirSync(wit)) if (file.endsWith(".wit")) copyFileSync(join(wit, file), join(snapshot, file));
  return { from, to, copied: true };
}

export function edit(path: string, change: (text: string) => string) {
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before) throw new Error(`${path}: nothing changed`);
  writeFileSync(path, after);
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const version = parseVersion(process.argv[2]);
  const current = cargoVersion(readFileSync(join(root, "Cargo.toml"), "utf8"));
  if (compare(version, current) <= 0) throw new Error(`${version} is not newer than the current ${current}`);

  edit(join(root, "Cargo.toml"), (text) => setCargoVersion(text, version));
  edit(join(root, "package.json"), (text) => setJsonVersion(text, version));
  edit(join(root, "src-tauri/tauri.conf.json"), (text) => setJsonVersion(text, version));
  const cargo = spawnSync("cargo", ["update", "--workspace"], { cwd: root, stdio: "inherit" });
  if (cargo.status !== 0) throw new Error("cargo update --workspace failed");
  console.log(`version ${current} -> ${version} (Cargo.toml, Cargo.lock, package.json, tauri.conf.json)`);

  const api = syncApiSnapshot(root);
  console.log(
    api.copied
      ? `plugin API ${api.from} -> ${api.to}: copied wit/*.wit to ${SNAPSHOT}/`
      : `plugin API ${api.to}: unchanged since the last release`,
  );
  console.log(`next: commit as "chore: v${version}", then tag v${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`release:prepare: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
