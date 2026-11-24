import { blake3 } from "@noble/hashes/blake3.js";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const APP_IDENTIFIER = "ai.l0ng.openidea";
export const PROBE_MARK = "__OPENIDEA_DOGFOOD_PROBE__";
export const BIN_MARK = "__OPENIDEA_DOGFOOD_BIN__:";
export const DOGFOOD_MARKER_FILE = ".dogfood-build-id";
export const RELEASE_BACKUP_FILE = "openidea-server.release.bak";

const SUPPORTED_PLATFORMS = new Set(["linux-x86_64", "linux-aarch64", "macos-aarch64", "macos-x86_64"]);

const WORKSPACE_SYNC_PATHS = [
  "Cargo.toml",
  "Cargo.lock",
  "crates",
  "src-tauri",
  "generators",
  "languages",
  "java",
  "plugins",
  "sdk",
  "wit",
  "src",
] as const;

export type SshAuthKind = "openSsh" | "keyPair" | "password";

export interface SshRemoteConfig {
  id: string;
  name: string;
  host: string;
  port?: number;
  user: string;
  auth: SshAuthKind;
  keyFile: string;
}

export type RestartPolicy = "prompt" | "always" | "never";

export interface DogfoodRemoteArgs {
  remoteName?: string;
  clean: boolean;
  installRust: boolean;
  restart: RestartPolicy;
  sshOpts: string[];
}

export interface WorkspaceMetadata {
  version: string;
  rustVersion: string;
}

export interface AppDirs {
  configDir: string;
  localDataDir: string;
}

export function blake3Hex16(data: Uint8Array): string {
  return Buffer.from(blake3(data)).toString("hex").slice(0, 16);
}

// --- Minimal TOML reader for `settings.toml` and `Cargo.toml` ---

type TomlTable = Record<string, unknown>;

class TomlCursor {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  eof(): boolean {
    return this.pos >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  skipInlineSpace() {
    while (this.peek() === " " || this.peek() === "\t") {
      this.pos++;
    }
  }

  skipBlankAndComments() {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.pos++;
      } else if (ch === "#") {
        while (!this.eof() && this.peek() !== "\n") this.pos++;
      } else {
        break;
      }
    }
  }

  skipLineTail() {
    this.skipInlineSpace();
    if (this.peek() === "#") {
      while (!this.eof() && this.peek() !== "\n") this.pos++;
    }
    if (this.peek() === "\r") this.pos++;
    if (this.peek() === "\n") this.pos++;
  }

  readBasicString(multiline: boolean): string {
    let out = "";
    if (multiline && this.peek() === "\r" && this.peek(1) === "\n") this.pos += 2;
    else if (multiline && this.peek() === "\n") this.pos += 1;

    while (!this.eof()) {
      if (multiline && this.text.startsWith('"""', this.pos)) {
        this.pos += 3;
        while (this.peek() === '"') {
          out += '"';
          this.pos++;
        }
        return out;
      }
      if (!multiline && this.peek() === '"') {
        this.pos++;
        return out;
      }
      const ch = this.peek();
      this.pos++;
      if (ch === "\\") {
        const esc = this.peek();
        this.pos++;
        if (multiline && (esc === "\n" || esc === "\r" || esc === " " || esc === "\t")) {
          while (this.peek() === " " || this.peek() === "\t" || this.peek() === "\r" || this.peek() === "\n") {
            this.pos++;
          }
          continue;
        }
        switch (esc) {
          case "b":
            out += "\b";
            break;
          case "t":
            out += "\t";
            break;
          case "n":
            out += "\n";
            break;
          case "f":
            out += "\f";
            break;
          case "r":
            out += "\r";
            break;
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            this.pos += 4;
            out += String.fromCodePoint(Number.parseInt(hex, 16));
            break;
          }
          case "U": {
            const hex = this.text.slice(this.pos, this.pos + 8);
            this.pos += 8;
            out += String.fromCodePoint(Number.parseInt(hex, 16));
            break;
          }
          default:
            out += esc;
        }
      } else {
        out += ch;
      }
    }
    throw new Error("Unterminated TOML basic string");
  }

  readLiteralString(multiline: boolean): string {
    if (multiline && this.peek() === "\r" && this.peek(1) === "\n") this.pos += 2;
    else if (multiline && this.peek() === "\n") this.pos += 1;
    let out = "";
    while (!this.eof()) {
      if (multiline && this.text.startsWith("'''", this.pos)) {
        this.pos += 3;
        return out;
      }
      if (!multiline && this.peek() === "'") {
        this.pos++;
        return out;
      }
      out += this.peek();
      this.pos++;
    }
    throw new Error("Unterminated TOML literal string");
  }

  readKeySegment(): string {
    this.skipInlineSpace();
    if (this.peek() === '"') {
      this.pos++;
      return this.readBasicString(false);
    }
    if (this.peek() === "'") {
      this.pos++;
      return this.readLiteralString(false);
    }
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_-]/.test(this.peek())) {
      this.pos++;
    }
    const key = this.text.slice(start, this.pos);
    if (!key) throw new Error(`Expected TOML key at offset ${this.pos}`);
    return key;
  }

  readDottedKey(): string[] {
    const parts = [this.readKeySegment()];
    while (true) {
      this.skipInlineSpace();
      if (this.peek() !== ".") break;
      this.pos++;
      parts.push(this.readKeySegment());
    }
    return parts;
  }

  readValue(): unknown {
    this.skipInlineSpace();
    if (this.text.startsWith('"""', this.pos)) {
      this.pos += 3;
      return this.readBasicString(true);
    }
    if (this.text.startsWith("'''", this.pos)) {
      this.pos += 3;
      return this.readLiteralString(true);
    }
    if (this.peek() === '"') {
      this.pos++;
      return this.readBasicString(false);
    }
    if (this.peek() === "'") {
      this.pos++;
      return this.readLiteralString(false);
    }
    if (this.peek() === "[") {
      this.pos++;
      const items: unknown[] = [];
      while (true) {
        this.skipBlankAndComments();
        if (this.peek() === "]") {
          this.pos++;
          return items;
        }
        items.push(this.readValue());
        this.skipBlankAndComments();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        if (this.peek() === "]") {
          this.pos++;
          return items;
        }
        throw new Error(`Expected ',' or ']' in TOML array at offset ${this.pos}`);
      }
    }
    if (this.peek() === "{") {
      this.pos++;
      const table: TomlTable = {};
      while (true) {
        this.skipBlankAndComments();
        if (this.peek() === "}") {
          this.pos++;
          return table;
        }
        const key = this.readDottedKey();
        this.skipInlineSpace();
        if (this.peek() !== "=") throw new Error(`Expected '=' in inline table at offset ${this.pos}`);
        this.pos++;
        setDotted(table, key, this.readValue());
        this.skipBlankAndComments();
        if (this.peek() === ",") {
          this.pos++;
          continue;
        }
        if (this.peek() === "}") {
          this.pos++;
          return table;
        }
        throw new Error(`Expected ',' or '}' in inline table at offset ${this.pos}`);
      }
    }

    const start = this.pos;
    while (!this.eof() && !/[\s,\]}#]/.test(this.peek())) {
      this.pos++;
    }
    const raw = this.text.slice(start, this.pos);
    if (raw === "true") return true;
    if (raw === "false") return false;
    const cleaned = raw.replaceAll("_", "");
    if (/^[+-]?(0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(cleaned)) {
      return Number(cleaned);
    }
    return raw;
  }
}

function isRecord(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureTable(root: TomlTable, path: readonly string[]): TomlTable {
  let cursor = root;
  for (const segment of path) {
    const existing = cursor[segment];
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (!isRecord(last)) throw new Error(`TOML path '${path.join(".")}' conflicts with non-table array`);
      cursor = last;
    } else if (isRecord(existing)) {
      cursor = existing;
    } else if (existing === undefined) {
      const next: TomlTable = {};
      cursor[segment] = next;
      cursor = next;
    } else {
      throw new Error(`TOML path '${path.join(".")}' conflicts with scalar value`);
    }
  }
  return cursor;
}

function setDotted(target: TomlTable, path: readonly string[], value: unknown) {
  const parent = ensureTable(target, path.slice(0, -1));
  const last = path[path.length - 1]!;
  parent[last] = value;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const cursor = new TomlCursor(text);

  while (!cursor.eof()) {
    cursor.skipBlankAndComments();
    if (cursor.eof()) break;

    if (cursor.text.startsWith("[[", cursor.pos)) {
      cursor.pos += 2;
      const path = cursor.readDottedKey();
      cursor.skipInlineSpace();
      if (!cursor.text.startsWith("]]", cursor.pos)) {
        throw new Error(`Expected ']]' at offset ${cursor.pos}`);
      }
      cursor.pos += 2;
      cursor.skipLineTail();
      const parent = ensureTable(root, path.slice(0, -1));
      const last = path[path.length - 1]!;
      const existing = parent[last];
      const entry: TomlTable = {};
      if (existing === undefined) {
        parent[last] = [entry];
      } else if (Array.isArray(existing)) {
        existing.push(entry);
      } else {
        throw new Error(`TOML array table '${path.join(".")}' conflicts with existing key`);
      }
      current = entry;
      continue;
    }

    if (cursor.peek() === "[") {
      cursor.pos += 1;
      const path = cursor.readDottedKey();
      cursor.skipInlineSpace();
      if (cursor.peek() !== "]") {
        throw new Error(`Expected ']' at offset ${cursor.pos}`);
      }
      cursor.pos += 1;
      cursor.skipLineTail();
      current = ensureTable(root, path);
      continue;
    }

    const key = cursor.readDottedKey();
    cursor.skipInlineSpace();
    if (cursor.peek() !== "=") {
      throw new Error(`Expected '=' after '${key.join(".")}' at offset ${cursor.pos}`);
    }
    cursor.pos += 1;
    const value = cursor.readValue();
    setDotted(current, key, value);
    cursor.skipLineTail();
  }

  return root;
}

// --- Configuration, paths, and SSH command building ---

function resolveEnvDir(envName: string, envValue: string | undefined, osDefault: string, identifier: string): string {
  const trimmed = envValue?.trim();
  if (!trimmed) return join(osDefault, identifier);
  if (!isAbsolute(trimmed)) {
    throw new Error(`${envName} must be an absolute path: ${trimmed}`);
  }
  return join(trimmed, identifier);
}

export function resolveAppDirs(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  identifier?: string;
}): AppDirs {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();
  const identifier = options?.identifier ?? APP_IDENTIFIER;

  let osConfig: string;
  let osLocalData: string;
  if (platform === "darwin") {
    osConfig = join(home, "Library", "Application Support");
    osLocalData = osConfig;
  } else if (platform === "win32") {
    osConfig = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    osLocalData = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
  } else {
    osConfig = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    osLocalData = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  }

  const configDir = resolveEnvDir("OPENIDEA_CONFIG_DIR", env.OPENIDEA_CONFIG_DIR, osConfig, identifier);

  const localEnv = env.OPENIDEA_LOCAL_DATA_DIR?.trim();
  if (localEnv) {
    return {
      configDir,
      localDataDir: resolveEnvDir("OPENIDEA_LOCAL_DATA_DIR", localEnv, osLocalData, identifier),
    };
  }

  const overrideFile = join(configDir, "local-data-dir.txt");
  if (existsSync(overrideFile)) {
    const stored = readFileSync(overrideFile, "utf8").trim();
    if (stored) {
      if (!isAbsolute(stored)) {
        throw new Error(`custom local data directory must be an absolute path: ${stored}`);
      }
      return { configDir, localDataDir: join(stored, identifier) };
    }
  }

  return { configDir, localDataDir: join(osLocalData, identifier) };
}

function parseSshConfigEntry(raw: unknown): SshRemoteConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (!name && !id) return undefined;
  const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : undefined;
  const user = typeof raw.user === "string" ? raw.user.trim() : "";
  const auth: SshAuthKind =
    raw.auth === "keyPair" || raw.auth === "password" || raw.auth === "openSsh" ? raw.auth : "openSsh";
  const keyFile = typeof raw.keyFile === "string" ? raw.keyFile.trim() : "";
  return { id, name: name || id, host, port, user, auth, keyFile };
}

function readSshConfigsFromFile(settingsFile: string): SshRemoteConfig[] | undefined {
  if (!existsSync(settingsFile)) return undefined;
  const doc = parseToml(readFileSync(settingsFile, "utf8"));
  const ssh = doc.ssh;
  if (!isRecord(ssh) || !Array.isArray(ssh.configs)) return undefined;
  return ssh.configs.map(parseSshConfigEntry).filter((entry): entry is SshRemoteConfig => entry !== undefined);
}

export function loadSshConfigs(configDir: string, projectRoot?: string): SshRemoteConfig[] {
  const globalConfigs = readSshConfigsFromFile(join(configDir, "settings.toml"));
  const projectConfigs = projectRoot
    ? readSshConfigsFromFile(join(projectRoot, ".openidea", "settings.toml"))
    : undefined;
  return projectConfigs ?? globalConfigs ?? [];
}

export function resolveSshConfig(configs: readonly SshRemoteConfig[], remoteName: string): SshRemoteConfig {
  const target = remoteName.trim();
  const match = configs.find((c) => c.name === target) ?? configs.find((c) => c.id === target);
  if (!match) {
    const available = configs.map((c) => c.name).filter(Boolean);
    const listHint =
      available.length > 0
        ? `Available SSH configurations: ${available.join(", ")}`
        : "No SSH configurations found in Settings › Tools › SSH Configurations (settings.toml).";
    throw new Error(`SSH configuration '${target}' not found. ${listHint}`);
  }
  if (!match.host) {
    throw new Error(`SSH configuration '${match.name}' has an empty host`);
  }
  return match;
}

export function expandTilde(filePath: string, home = homedir()): string {
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

export function formatRemoteEndpoint(config: SshRemoteConfig): string {
  const userPrefix = config.user ? `${config.user}@` : "";
  const portSuffix = config.port !== undefined ? `:${config.port}` : "";
  return `${userPrefix}${config.host}${portSuffix}`;
}

export function buildSshArgs(
  config: SshRemoteConfig,
  extraSshOpts: readonly string[] = [],
  home = homedir(),
): string[] {
  const args: string[] = [];
  if (config.port !== undefined) {
    args.push("-p", String(config.port));
  }
  if (config.user) {
    args.push("-l", config.user);
  }
  if (config.auth === "keyPair" && config.keyFile) {
    args.push("-i", expandTilde(config.keyFile, home));
  }
  const hasConnectTimeout = extraSshOpts.some((opt) => /^ConnectTimeout\s*=/i.test(opt));
  if (!hasConnectTimeout) {
    args.push("-o", "ConnectTimeout=10");
  }
  for (const opt of extraSshOpts) {
    args.push("-o", opt);
  }
  args.push("--", config.host);
  return args;
}

export function parseRustVersion(versionOutput: string): [number, number, number] | undefined {
  const match = /(?:^|\b)rustc\s+(\d+)\.(\d+)(?:\.(\d+))?|^(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput.trim());
  if (!match) return undefined;
  const major = Number(match[1] ?? match[4]);
  const minor = Number(match[2] ?? match[5]);
  const patch = Number(match[3] ?? match[6] ?? "0");
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return undefined;
  return [major, minor, patch];
}

export function isRustVersionAtLeast(actualOutput: string, minimumRequired: string): boolean {
  const actual = parseRustVersion(actualOutput);
  const minimum = parseRustVersion(minimumRequired);
  if (!actual || !minimum) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true;
}

export function parseRunningServerPids(psOutput: string): number[] {
  const pids = new Set<number>();
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const exe = match[2] ?? "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (exe === "openidea-server" || exe.endsWith("/openidea-server")) {
      pids.add(pid);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

export function formatSshConnectionError(
  remoteName: string,
  endpoint: string,
  stderrText: string,
  status: number | null,
): string {
  const detail = stderrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Warning: Permanently added "))
    .join("; ");
  const reason = detail || `ssh exited with status ${status ?? "unknown"}`;
  return `Cannot connect to SSH remote '${remoteName}' (${endpoint}): ${reason}. Verify the host is reachable and check Settings › Tools › SSH Configurations.`;
}

export function normalizeRemotePlatform(uname: string): { os: string; arch: string } {
  const parts = uname.trim().split(/\s+/);
  const rawOs = (parts[0] ?? "").toLowerCase();
  const rawArch = parts[1] ?? "";
  const os = rawOs === "darwin" ? "macos" : rawOs;
  const arch = rawArch === "arm64" ? "aarch64" : rawArch === "amd64" ? "x86_64" : rawArch;
  const key = `${os}-${arch}`;
  if (!SUPPORTED_PLATFORMS.has(key)) {
    throw new Error(`Unsupported remote platform '${key}' (from uname '${uname.trim()}')`);
  }
  return { os, arch };
}

export function parseDogfoodRemoteArgs(args: readonly string[]): DogfoodRemoteArgs {
  const filtered = args.filter((arg) => arg !== "--");
  let remoteName: string | undefined;
  let clean = false;
  let installRust = false;
  let sawRestart = false;
  let sawNoRestart = false;
  const sshOpts: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i]!;
    if (arg === "--clean") {
      clean = true;
    } else if (arg === "--install-rust") {
      installRust = true;
    } else if (arg === "--restart") {
      sawRestart = true;
    } else if (arg === "--no-restart") {
      sawNoRestart = true;
    } else if (arg === "--ssh-opt") {
      const value = filtered[i + 1];
      if (!value) throw new Error("--ssh-opt requires a key=value argument");
      sshOpts.push(value);
      i += 1;
    } else if (arg.startsWith("--ssh-opt=")) {
      sshOpts.push(arg.slice("--ssh-opt=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unexpected option '${arg}'`);
    } else if (remoteName === undefined) {
      remoteName = arg;
    } else {
      throw new Error(`Unexpected extra argument '${arg}'`);
    }
  }

  if (sawRestart && sawNoRestart) {
    throw new Error("Cannot pass both '--restart' and '--no-restart'");
  }

  if (!remoteName && !clean) {
    throw new Error(
      "Usage: dogfood:remote <remote_name> [--clean] [--install-rust] [--restart | --no-restart] [--ssh-opt key=value]",
    );
  }

  const restart: RestartPolicy = sawRestart ? "always" : sawNoRestart ? "never" : "prompt";
  return { remoteName, clean, installRust, restart, sshOpts };
}

export function readWorkspaceMetadata(root: string): WorkspaceMetadata {
  const cargoToml = parseToml(readFileSync(join(root, "Cargo.toml"), "utf8"));
  const workspace = cargoToml.workspace;
  if (isRecord(workspace) && isRecord(workspace.package)) {
    const version = workspace.package.version;
    const rustVersion = workspace.package["rust-version"];
    if (typeof version === "string" && typeof rustVersion === "string") {
      return { version, rustVersion };
    }
  }
  throw new Error("Could not read [workspace.package].version and rust-version from Cargo.toml");
}

// --- Local server cache staging & clean restoration ---

export function stageLocalDogfoodServer(
  localDataDir: string,
  version: string,
  os: string,
  arch: string,
  binary: Uint8Array,
  buildId: string,
): string {
  const dir = join(localDataDir, "server", version, `${os}-${arch}`);
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, "openidea-server");
  const backupPath = join(dir, RELEASE_BACKUP_FILE);
  const markerPath = join(dir, DOGFOOD_MARKER_FILE);

  if (existsSync(binPath) && !existsSync(markerPath) && !existsSync(backupPath)) {
    renameSync(binPath, backupPath);
  }

  const tmpPath = join(dir, `.openidea-server.${process.pid}.tmp`);
  writeFileSync(tmpPath, binary);
  chmodSync(tmpPath, 0o755);
  renameSync(tmpPath, binPath);
  writeFileSync(markerPath, `${buildId}\n`);
  return binPath;
}

export interface CleanedOverride {
  platformKey: string;
  buildId: string;
  restoredRelease: boolean;
}

export function cleanLocalDogfoodServers(
  localDataDir: string,
  version: string,
  platformKeyFilter?: string,
): CleanedOverride[] {
  const versionDir = join(localDataDir, "server", version);
  if (!existsSync(versionDir)) return [];
  const cleaned: CleanedOverride[] = [];

  for (const entry of readdirSync(versionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (platformKeyFilter && entry.name !== platformKeyFilter) continue;
    const dir = join(versionDir, entry.name);
    const markerPath = join(dir, DOGFOOD_MARKER_FILE);
    if (!existsSync(markerPath)) continue;

    const buildId = readFileSync(markerPath, "utf8").trim();
    const binPath = join(dir, "openidea-server");
    const backupPath = join(dir, RELEASE_BACKUP_FILE);

    rmSync(binPath, { force: true });
    rmSync(markerPath, { force: true });
    let restoredRelease = false;
    if (existsSync(backupPath)) {
      renameSync(backupPath, binPath);
      restoredRelease = true;
    }
    cleaned.push({ platformKey: entry.name, buildId, restoredRelease });
  }
  return cleaned;
}

export function extractFramedBinary(stdout: Buffer): Buffer {
  const markerBytes = Buffer.from(BIN_MARK, "utf8");
  const idx = stdout.indexOf(markerBytes);
  if (idx === -1) {
    throw new Error("Remote stream did not contain openidea-server binary header");
  }
  const headerStart = idx + markerBytes.length;
  const newline = stdout.indexOf(0x0a, headerStart);
  if (newline === -1) {
    throw new Error("Malformed openidea-server binary header");
  }
  const expectedSha256 = stdout.subarray(headerStart, newline).toString("utf8").trim();
  const payload = stdout.subarray(newline + 1);
  const actualSha256 = createHash("sha256").update(payload).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Downloaded openidea-server SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return payload;
}

// --- Remote execution helpers ---

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface RemoteContext {
  name: string;
  endpoint: string;
}

const REMOTE_PATH_SETUP = `export PATH="$HOME/.cargo/bin:$HOME/.local/share/mise/shims:$PATH"; . "$HOME/.cargo/env" 2>/dev/null || true`;

function runSshCapture(sshArgs: readonly string[], remoteScript: string, remote?: RemoteContext): Buffer {
  const result = spawnSync("ssh", [...sshArgs, remoteScript], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) {
    if (remote) {
      throw new Error(formatSshConnectionError(remote.name, remote.endpoint, result.error.message, null));
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderrText = result.stderr?.toString("utf8") ?? "";
    if (remote && result.status === 255) {
      throw new Error(formatSshConnectionError(remote.name, remote.endpoint, stderrText, result.status));
    }
    const detail = stderrText.trim();
    throw new Error(
      `Remote command${remote ? ` on '${remote.name}'` : ""} exited with status ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function runSshInteractive(sshArgs: readonly string[], remoteScript: string, remote?: RemoteContext) {
  const result = spawnSync("ssh", [...sshArgs, remoteScript], {
    stdio: "inherit",
  });
  if (result.error) {
    if (remote) {
      throw new Error(formatSshConnectionError(remote.name, remote.endpoint, result.error.message, null));
    }
    throw result.error;
  }
  if (result.status !== 0) {
    if (remote && result.status === 255) {
      throw new Error(formatSshConnectionError(remote.name, remote.endpoint, "", result.status));
    }
    throw new Error(`Remote command${remote ? ` on '${remote.name}'` : ""} exited with status ${result.status}`);
  }
}

export function workspaceTarArgs(): string[] {
  // Never pass bare `--exclude=target`: BSD/GNU tar matches nested source folders like `crates/ide-ssh/src/target`.
  return [
    "--exclude=plugins/target",
    "--exclude=sdk/target",
    "--exclude=src-tauri/target",
    "--exclude=plugins/official/*/web-src/node_modules",
    "--exclude=.DS_Store",
    "--exclude=*.tsbuildinfo",
    "-czf",
    "-",
    ...WORKSPACE_SYNC_PATHS,
  ];
}

async function syncWorkspaceOverSsh(root: string, sshArgs: readonly string[], remoteCacheRoot: string) {
  const cleanSubdirs = WORKSPACE_SYNC_PATHS.filter((p) => p !== "Cargo.toml" && p !== "Cargo.lock").join(" ");
  // Extract into a staging folder and sync by checksum via `rsync -rc` when available so unchanged
  // crates and asset directories keep their mtimes and Cargo only recompiles touched crates.
  const remoteScript = [
    `set -eu`,
    `stage=${remoteCacheRoot}/staging.$$`,
    `ws=${remoteCacheRoot}/workspace`,
    `rm -rf "$stage"`,
    `mkdir -p "$stage" "$ws"`,
    `tar xzf - -C "$stage"`,
    `if command -v rsync >/dev/null 2>&1; then`,
    `  rsync -rc --delete --exclude='/target' "$stage/" "$ws/"`,
    `else`,
    `  (cd "$ws" && rm -rf ${cleanSubdirs})`,
    `  cp -RPp "$stage/." "$ws/"`,
    `fi`,
    `rm -rf "$stage"`,
  ].join("\n");
  const tarArgs = workspaceTarArgs();

  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", tarArgs, {
      cwd: root,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const ssh = spawn("ssh", [...sshArgs, remoteScript], {
      stdio: ["pipe", "inherit", "inherit"],
    });

    ssh.stdin.on("error", () => {});
    tar.stdout.pipe(ssh.stdin);
    let tarCode: number | null = null;
    let sshCode: number | null = null;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      tar.kill();
      ssh.kill();
      reject(err);
    };
    const maybeDone = () => {
      if (settled || tarCode === null || sshCode === null) return;
      settled = true;
      if (tarCode !== 0) reject(new Error(`tar exited with status ${tarCode}`));
      else if (sshCode !== 0) reject(new Error(`ssh tar extract exited with status ${sshCode}`));
      else resolve();
    };

    tar.once("error", fail);
    ssh.once("error", fail);
    tar.once("close", (code) => {
      tarCode = code ?? 1;
      if (tarCode !== 0) fail(new Error(`tar exited with status ${tarCode}`));
      else maybeDone();
    });
    ssh.once("close", (code) => {
      sshCode = code ?? 1;
      if (sshCode !== 0) fail(new Error(`ssh tar extract exited with status ${sshCode}`));
      else maybeDone();
    });
  });
}

interface RemoteProbe {
  os: string;
  arch: string;
  hasCargo: boolean;
  rustcVersion?: string;
  hasRustup: boolean;
}

function extractMarkedLines(raw: string): string[] {
  const after = raw.includes(PROBE_MARK) ? raw.slice(raw.indexOf(PROBE_MARK) + PROBE_MARK.length) : raw;
  return after
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function probeRemote(sshArgs: readonly string[], remote: RemoteContext): RemoteProbe {
  const script = [
    REMOTE_PATH_SETUP,
    `printf '${PROBE_MARK}\\n'`,
    `uname -sm`,
    `if command -v cargo >/dev/null 2>&1; then echo has-cargo; else echo no-cargo; fi`,
    `rustc --version 2>/dev/null || echo no-rustc`,
    `if command -v rustup >/dev/null 2>&1; then echo has-rustup; else echo no-rustup; fi`,
  ].join("; ");
  const lines = extractMarkedLines(runSshCapture(sshArgs, script, remote).toString("utf8"));
  const { os, arch } = normalizeRemotePlatform(lines[0] ?? "");
  const hasCargo = lines[1] === "has-cargo";
  const rustcRaw = lines[2] ?? "no-rustc";
  const rustcVersion = rustcRaw === "no-rustc" ? undefined : rustcRaw;
  const hasRustup = lines[3] === "has-rustup";
  return { os, arch, hasCargo, rustcVersion, hasRustup };
}

function ensureRemoteRustToolchain(
  sshArgs: readonly string[],
  remote: RemoteContext,
  probe: RemoteProbe,
  requiredRustVersion: string,
  installRust: boolean,
) {
  if (probe.hasCargo && probe.rustcVersion && isRustVersionAtLeast(probe.rustcVersion, requiredRustVersion)) {
    return;
  }

  if (!probe.hasCargo || !probe.rustcVersion) {
    if (!installRust) {
      throw new Error(
        `Rust toolchain ('cargo'/'rustc' >= ${requiredRustVersion}) is not installed on '${remote.name}'. Install Rust on the remote host or re-run with '--install-rust'.`,
      );
    }
    console.log(`Installing minimal Rust toolchain on '${remote.name}'...`);
    runSshInteractive(
      sshArgs,
      `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal`,
      remote,
    );
  } else {
    if (!installRust) {
      const hint = probe.hasRustup
        ? `Run 'rustup update stable' on '${remote.name}' or re-run with '--install-rust'.`
        : `Update Rust on '${remote.name}' or re-run with '--install-rust' to install a current toolchain in ~/.cargo.`;
      throw new Error(
        `Rust on '${remote.name}' is too old (${probe.rustcVersion}; Cargo.toml requires rust-version >= ${requiredRustVersion}). ${hint}`,
      );
    }
    if (probe.hasRustup) {
      console.log(`Updating Rust stable toolchain on '${remote.name}' (found ${probe.rustcVersion})...`);
      runSshInteractive(
        sshArgs,
        `${REMOTE_PATH_SETUP}; rustup toolchain install stable --profile minimal && rustup default stable`,
        remote,
      );
    } else {
      console.log(
        `Installing current Rust toolchain into ~/.cargo on '${remote.name}' (found ${probe.rustcVersion})...`,
      );
      runSshInteractive(
        sshArgs,
        `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal`,
        remote,
      );
    }
  }

  const updated = probeRemote(sshArgs, remote);
  if (!updated.hasCargo || !updated.rustcVersion || !isRustVersionAtLeast(updated.rustcVersion, requiredRustVersion)) {
    throw new Error(
      `Rust on '${remote.name}' still does not meet rust-version >= ${requiredRustVersion} (active: ${updated.rustcVersion ?? "none"}). Check remote PATH precedence.`,
    );
  }
}

function listRunningRemoteServers(sshArgs: readonly string[], remote: RemoteContext): number[] {
  const script = `printf '${PROBE_MARK}\\n'; ps -u "$(id -u)" -o pid=,args= 2>/dev/null || true`;
  const raw = runSshCapture(sshArgs, script, remote).toString("utf8");
  const after = raw.includes(PROBE_MARK) ? raw.slice(raw.indexOf(PROBE_MARK) + PROBE_MARK.length) : raw;
  return parseRunningServerPids(after);
}

async function askYesNo(promptText: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(promptText);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function handleRunningRemoteServers(
  sshArgs: readonly string[],
  remote: RemoteContext,
  buildId: string,
  policy: RestartPolicy,
) {
  const runningPids = listRunningRemoteServers(sshArgs, remote);
  if (runningPids.length === 0) return;

  const pidList = runningPids.join(", ");
  let shouldRestart = false;
  if (policy === "always") {
    shouldRestart = true;
  } else if (policy === "never") {
    shouldRestart = false;
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    shouldRestart = await askYesNo(
      `Found ${runningPids.length} running openidea-server instance(s) on '${remote.name}' (PID ${pidList}). Stop them now so connected OpenIDEA windows reconnect to build ${buildId}? [y/N] `,
    );
  }

  if (shouldRestart) {
    runSshInteractive(sshArgs, `kill ${runningPids.join(" ")} 2>/dev/null || true`, remote);
    console.log(
      `Stopped running openidea-server instance(s) (PID ${pidList}) on '${remote.name}'; connected OpenIDEA windows will reconnect to build ${buildId}.`,
    );
  } else {
    console.log(
      `Note: ${runningPids.length} openidea-server instance(s) still running on '${remote.name}' (PID ${pidList}). Reconnect in OpenIDEA (or re-run with '--restart') to switch active windows to build ${buildId}.`,
    );
  }
}

export async function runDogfoodRemote(root: string, cliArgs: readonly string[]) {
  const parsed = parseDogfoodRemoteArgs(cliArgs);
  const { version, rustVersion } = readWorkspaceMetadata(root);
  const { configDir, localDataDir } = resolveAppDirs();

  const envOpts = (process.env.DOGFOOD_SSH_OPTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const extraSshOpts = [...envOpts, ...parsed.sshOpts];

  if (parsed.clean && !parsed.remoteName) {
    const cleaned = cleanLocalDogfoodServers(localDataDir, version);
    if (cleaned.length === 0) {
      console.log(`No local dogfood openidea-server overrides found for v${version}`);
    } else {
      for (const item of cleaned) {
        console.log(
          `Removed local dogfood override for ${item.platformKey} (${item.buildId})${item.restoredRelease ? " and restored cached release binary" : ""}`,
        );
      }
    }
    return;
  }

  const configs = loadSshConfigs(configDir, root);
  const remoteConfig = resolveSshConfig(configs, parsed.remoteName!);
  const remoteContext: RemoteContext = {
    name: remoteConfig.name,
    endpoint: formatRemoteEndpoint(remoteConfig),
  };
  const sshArgs = buildSshArgs(remoteConfig, extraSshOpts);
  const probe = probeRemote(sshArgs, remoteContext);
  const { os, arch } = probe;
  const platformKey = `${os}-${arch}`;

  if (parsed.clean) {
    const cleaned = cleanLocalDogfoodServers(localDataDir, version, platformKey);
    for (const item of cleaned) {
      if (/^[0-9a-f]{16}$/.test(item.buildId)) {
        runSshInteractive(sshArgs, `rm -rf "$HOME/.openidea/server/${version}/${item.buildId}"`, remoteContext);
      }
      console.log(
        `Cleaned dogfood openidea-server (${item.buildId}) for ${remoteConfig.name} (${platformKey})${item.restoredRelease ? " and restored cached release binary" : ""}`,
      );
    }
    if (cleaned.length === 0) {
      console.log(`No dogfood openidea-server override found for ${remoteConfig.name} (${platformKey}, v${version})`);
    }
    return;
  }

  ensureRemoteRustToolchain(sshArgs, remoteContext, probe, rustVersion, parsed.installRust);

  const remoteCacheRoot = '"$HOME/.cache/openidea-dogfood"';
  console.log(`Syncing backend workspace to '${remoteConfig.name}' (${platformKey})...`);
  await syncWorkspaceOverSsh(root, sshArgs, remoteCacheRoot);

  const lto = process.env.CARGO_PROFILE_RELEASE_LTO ?? "off";
  const codegenUnits = process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS ?? "16";
  console.log(`Building openidea-server v${version} on '${remoteConfig.name}'...`);
  runSshInteractive(
    sshArgs,
    `${REMOTE_PATH_SETUP}; cd "$HOME/.cache/openidea-dogfood/workspace" && CARGO_PROFILE_RELEASE_LTO=${shellQuote(lto)} CARGO_PROFILE_RELEASE_CODEGEN_UNITS=${shellQuote(codegenUnits)} cargo build --release --locked -p ide-host --bin openidea-server`,
    remoteContext,
  );

  console.log(`Fetching built openidea-server from '${remoteConfig.name}'...`);
  const rawStream = runSshCapture(
    sshArgs,
    `bin="$HOME/.cache/openidea-dogfood/workspace/target/release/openidea-server"; sum="$( (sha256sum "$bin" 2>/dev/null || shasum -a 256 "$bin") | awk '{print $1}' )"; printf '${BIN_MARK}%s\\n' "$sum"; cat "$bin"`,
    remoteContext,
  );
  const binary = extractFramedBinary(rawStream);
  const buildId = blake3Hex16(binary);

  console.log(`Installing openidea-server (${buildId}) on '${remoteConfig.name}'...`);
  runSshInteractive(
    sshArgs,
    `set -eu; dir="$HOME/.openidea/server/${version}"; dest="$dir/${buildId}"; mkdir -p "$dest"; tmp="$dest/openidea-server.$$.part"; cp "$HOME/.cache/openidea-dogfood/workspace/target/release/openidea-server" "$tmp"; chmod 755 "$tmp"; mv -f "$tmp" "$dest/openidea-server"; find "$dir" -mindepth 1 -maxdepth 1 ! -name ${shellQuote(buildId)} -exec rm -rf {} +`,
    remoteContext,
  );

  const stagedPath = stageLocalDogfoodServer(localDataDir, version, os, arch, binary, buildId);
  console.log(
    `Installed dogfood openidea-server v${version} (${buildId}) on '${remoteConfig.name}' (~/.openidea/server/${version}/${buildId}/openidea-server) and staged ${stagedPath}`,
  );

  await handleRunningRemoteServers(sshArgs, remoteContext, buildId, parsed.restart);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
    await runDogfoodRemote(root, process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
