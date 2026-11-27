// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BIN_MARK,
  blake3Hex16,
  buildSshArgs,
  cleanLocalDogfoodServers,
  extractFramedBinary,
  formatSshConnectionError,
  isRustVersionAtLeast,
  loadSshConfigs,
  normalizeRemotePlatform,
  parseDogfoodRemoteArgs,
  parseRunningServerPids,
  parseToml,
  readWorkspaceMetadata,
  resolveAppDirs,
  resolveSshConfig,
  stageLocalDogfoodServer,
  workspaceTarArgs,
} from "./dogfood-remote.ts";

function blake3TestInput(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

describe("dogfood:remote", () => {
  it("computes the 16-character BLAKE3 build_id expected by remote_dev::ensure_server", () => {
    // Reference vector (input[i] = i % 251, 2049 bytes -> multi-chunk tree) matching `blake3::hash(bytes).to_hex()[..16]`.
    expect(blake3Hex16(blake3TestInput(2049))).toBe("5f4d72f40d7a5f82");
  });

  it("parses both UI inline-table and [[ssh.configs]] TOML settings formats", () => {
    const temp = mkdtempSync(join(tmpdir(), "openidea-dogfood-remote-"));
    try {
      const configDir = join(temp, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "settings.toml"),
        [
          "# Global settings written by Settings › Tools › SSH Configurations",
          "[appearance]",
          'locale = "en"',
          "",
          "[ssh]",
          'configs = [{ id = "cfg-1", name = "my-remote", host = "remote-host.example.com", port = 2222, user = "alice", auth = "keyPair", keyFile = "~/.ssh/id_ed25519", saveSecret = false }]',
          "",
        ].join("\n"),
      );

      const loaded = loadSshConfigs(configDir);
      expect(loaded).toEqual([
        {
          id: "cfg-1",
          name: "my-remote",
          host: "remote-host.example.com",
          port: 2222,
          user: "alice",
          auth: "keyPair",
          keyFile: "~/.ssh/id_ed25519",
        },
      ]);

      const resolved = resolveSshConfig(loaded, "my-remote");
      expect(buildSshArgs(resolved, ["StrictHostKeyChecking=no"], "/Users/alice")).toEqual([
        "-p",
        "2222",
        "-l",
        "alice",
        "-i",
        join("/Users/alice", ".ssh", "id_ed25519"),
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=no",
        "--",
        "remote-host.example.com",
      ]);

      expect(() => resolveSshConfig(loaded, "missing-box")).toThrow(/Available SSH configurations: my-remote/);

      const tableDoc = parseToml(
        ["[[ssh.configs]]", 'name = "alt-remote"', 'host = "alt.example.com"', 'user = "bob"', 'auth = "openSsh"'].join(
          "\n",
        ),
      );
      expect(tableDoc).toEqual({
        ssh: {
          configs: [{ name: "alt-remote", host: "alt.example.com", user: "bob", auth: "openSsh" }],
        },
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("resolves config and custom local-data directories like ide_host::data_dirs", () => {
    const temp = mkdtempSync(join(tmpdir(), "openidea-dirs-"));
    try {
      const cfgRoot = join(temp, "cfg");
      const customLocalRoot = join(temp, "custom-caches");
      mkdirSync(join(cfgRoot, "ai.l0ng.openidea"), { recursive: true });
      writeFileSync(join(cfgRoot, "ai.l0ng.openidea", "local-data-dir.txt"), `${customLocalRoot}\n`);

      expect(
        resolveAppDirs({
          platform: "darwin",
          env: { OPENIDEA_CONFIG_DIR: cfgRoot },
          home: "/Users/alice",
        }),
      ).toEqual({
        configDir: join(cfgRoot, "ai.l0ng.openidea"),
        localDataDir: join(customLocalRoot, "ai.l0ng.openidea"),
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("parses CLI flags and normalizes remote uname platforms", () => {
    expect(
      parseDogfoodRemoteArgs(["--", "my-remote", "--install-rust", "--restart", "--ssh-opt", "Port=2222"]),
    ).toEqual({
      remoteName: "my-remote",
      clean: false,
      installRust: true,
      restart: "always",
      sshOpts: ["Port=2222"],
    });
    expect(parseDogfoodRemoteArgs(["--clean"])).toEqual({
      remoteName: undefined,
      clean: true,
      installRust: false,
      restart: "prompt",
      sshOpts: [],
    });
    expect(() => parseDogfoodRemoteArgs(["my-remote", "--restart", "--no-restart"])).toThrow(/Cannot pass both/);
    expect(() => parseDogfoodRemoteArgs([])).toThrow(/Usage:/);
    expect(normalizeRemotePlatform("Linux x86_64\n")).toEqual({ os: "linux", arch: "x86_64" });
    expect(normalizeRemotePlatform("Linux aarch64")).toEqual({ os: "linux", arch: "aarch64" });
    expect(normalizeRemotePlatform("Darwin arm64")).toEqual({ os: "macos", arch: "aarch64" });
  });

  it("handles connection errors, Rust version checks, and running openidea-server PID detection", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const meta = readWorkspaceMetadata(repoRoot);
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.rustVersion).toMatch(/^\d+\.\d+/);

    expect(isRustVersionAtLeast("rustc 1.96.0 (0000000 2026-06-01)", "1.96")).toBe(true);
    expect(isRustVersionAtLeast("rustc 1.100.0-nightly (abcdef0 2026-11-01)", "1.96")).toBe(true);
    expect(isRustVersionAtLeast("rustc 1.75.0 (82e1608df 2023-12-21)", "1.96")).toBe(false);
    expect(isRustVersionAtLeast("no-rustc", "1.96")).toBe(false);

    const errMsg = formatSshConnectionError(
      "my-remote",
      "alice@remote-host.example.com:22",
      "Warning: Permanently added 'remote-host.example.com' (ED25519) to the list of known hosts.\nssh: connect to host remote-host.example.com port 22: Connection refused\n",
      255,
    );
    expect(errMsg).toContain("Cannot connect to SSH remote 'my-remote' (alice@remote-host.example.com:22)");
    expect(errMsg).toContain("Connection refused");
    expect(errMsg).not.toContain("Permanently added");

    const psText = [
      "  101 /bin/bash",
      " 4321 /home/alice/.openidea/server/0.1.50/42bd8ae098588d22/openidea-server --stdio",
      " 4399 openidea-server --stdio",
      " 4500 grep openidea-server",
    ].join("\n");
    expect(parseRunningServerPids(psText)).toEqual([4321, 4399]);
  });

  it("backs up an existing cached release server on stage and restores it on --clean", () => {
    const temp = mkdtempSync(join(tmpdir(), "openidea-stage-"));
    try {
      const serverDir = join(temp, "server", "0.1.50", "linux-aarch64");
      mkdirSync(serverDir, { recursive: true });
      const binPath = join(serverDir, "openidea-server");
      writeFileSync(binPath, "official-release-binary");

      const dogfoodBytes = Buffer.from("dogfood-server-binary-v1");
      const id1 = blake3Hex16(dogfoodBytes);
      stageLocalDogfoodServer(temp, "0.1.50", "linux", "aarch64", dogfoodBytes, id1);
      expect(readFileSync(binPath, "utf8")).toBe("dogfood-server-binary-v1");

      // A second dogfood build must keep the original release backup intact.
      const dogfoodBytes2 = Buffer.from("dogfood-server-binary-v2");
      const id2 = blake3Hex16(dogfoodBytes2);
      stageLocalDogfoodServer(temp, "0.1.50", "linux", "aarch64", dogfoodBytes2, id2);
      expect(readFileSync(binPath, "utf8")).toBe("dogfood-server-binary-v2");

      const cleaned = cleanLocalDogfoodServers(temp, "0.1.50", "linux-aarch64");
      expect(cleaned).toEqual([{ platformKey: "linux-aarch64", buildId: id2, restoredRelease: true }]);
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath, "utf8")).toBe("official-release-binary");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("strips login shell banners before the framed binary stream and verifies SHA-256", () => {
    const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
    const sha = createHash("sha256").update(payload).digest("hex");
    const framed = Buffer.concat([Buffer.from(`Welcome to Ubuntu!\n${BIN_MARK}${sha}\n`, "utf8"), payload]);
    expect(extractFramedBinary(framed)).toEqual(payload);
    expect(() => extractFramedBinary(Buffer.from(`${BIN_MARK}${"0".repeat(64)}\ncorrupt`))).toThrow(/SHA-256 mismatch/);
  });

  it("anchors tar Cargo target exclusions so nested source folders like crates/ide-ssh/src/target stay included", () => {
    const args = workspaceTarArgs();
    expect(args).not.toContain("--exclude=target");
    expect(args).toContain("--exclude=plugins/target");
    expect(args).toContain("crates");
    expect(args).toContain("generators");
  });
});
