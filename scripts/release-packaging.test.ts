// @vitest-environment node
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageScript = join(root, "scripts/package-linux-desktop.sh");
const manifest = join(root, "release.toml");
const packslip = process.env.PACKSLIP_BIN;
// The regular pnpm suite does not download packslip; the dedicated CI job sets
// REQUIRE_PACKSLIP to make a missing CLI fail instead of silently skipping.
if (process.env.REQUIRE_PACKSLIP === "1" && !packslip) {
  throw new Error("PACKSLIP_BIN is required by the release-packaging CI job");
}
const supportedTargets = [
  ["x86_64-unknown-linux-gnu", "x86_64"],
  ["aarch64-unknown-linux-gnu", "aarch64"],
] as const;
const testCommit = "0123456789abcdef0123456789abcdef01234567";

let workspace = "";

function fixture() {
  workspace = mkdtempSync(join(tmpdir(), "openidea-release-test-"));
  const source = join(workspace, "source/openidea");
  const dist = join(workspace, "dist");
  mkdirSync(join(workspace, "source"));
  mkdirSync(dist);
  writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { source, dist };
}

function packageForTarget(target: string, source: string, dist: string) {
  execFileSync(packageScript, [target, source, dist], { cwd: workspace });
}

function archiveFor(dist: string, arch: string) {
  return join(dist, `openidea-linux-${arch}.tar.gz`);
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("Linux desktop release packaging", () => {
  it.skipIf(process.platform !== "linux")(
    "archives the raw executable and writes a matching checksum for both Linux targets",
    () => {
      for (const [target, arch] of supportedTargets) {
        const { source, dist } = fixture();
        packageForTarget(target, source, dist);

        const asset = archiveFor(dist, arch);
        const entries = execFileSync("tar", ["-tzf", asset], { encoding: "utf8" }).trim().split("\n");
        expect(entries).toEqual(["openidea"]);
        const mode = execFileSync("tar", ["-tvzf", asset], { encoding: "utf8" }).trimEnd();
        expect(mode).toMatch(/^-rwx[\S]*\s+.*\bopenidea$/);
        expect(execFileSync("tar", ["-xOf", asset, "openidea"])).toEqual(readFileSync(source));

        const checksumFile = `${asset}.sha256`;
        const checksum = readFileSync(checksumFile, "utf8");
        const digest = createHash("sha256").update(readFileSync(asset)).digest("hex");
        expect(checksum).toBe(`${digest}  ${basename(asset)}\n`);

        rmSync(workspace, { recursive: true, force: true });
        workspace = "";
      }
    },
  );

  it.skipIf(process.platform !== "linux")("rejects targets outside the release matrix", () => {
    const { source, dist } = fixture();
    const result = spawnSync(packageScript, ["i686-unknown-linux-gnu", source, dist], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported Linux target");
  });

  it.skipIf(process.platform !== "linux")("rejects missing and non-executable source binaries", () => {
    const { source, dist } = fixture();
    const missing = spawnSync(packageScript, [supportedTargets[0][0], `${source}.missing`, dist], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(missing.status).not.toBe(0);

    chmodSync(source, 0o644);
    const nonExecutable = spawnSync(packageScript, [supportedTargets[0][0], source, dist], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(nonExecutable.status).not.toBe(0);
  });

  it("declares the Linux binaries and glibc minimum in the packslip manifest", () => {
    const text = readFileSync(manifest, "utf8");
    expect(text.match(/^path = "dist\/openidea-linux-/gm)).toHaveLength(2);
    expect(text.match(/^requires = \{ glibc_min = "2\.35" \}$/gm)).toHaveLength(2);
    expect(text).toContain('bin = ["openidea"]');
  });

  it.skipIf(!packslip || process.platform !== "linux")(
    "signs and verifies both packslip artifacts, platforms, executable names, glibc minimums, and digests",
    () => {
      const { source, dist } = fixture();
      for (const [target] of supportedTargets) packageForTarget(target, source, dist);
      copyFileSync(manifest, join(workspace, "release.toml"));

      execFileSync(packslip!, ["keygen", "--out", "test.key"], { cwd: workspace });
      const artifacts = supportedTargets.map(([, arch]) => `dist/openidea-linux-${arch}.tar.gz`);
      execFileSync(
        packslip!,
        [
          "create",
          "--manifest",
          "release.toml",
          "--version",
          "1.2.3",
          "--tag",
          "v1.2.3",
          "--source-repo",
          "https://github.com/l0ng-ai/openidea",
          "--commit",
          testCommit,
          "--key",
          "test.key",
          "--no-log",
          "--out",
          "out",
          ...artifacts,
        ],
        { cwd: workspace },
      );

      const bundle = join(workspace, "out/packslip.sigstore.json");
      const statement = JSON.parse(execFileSync(packslip!, ["show", bundle], { encoding: "utf8" }));
      expect(statement.predicate.project).toBe("github.com/l0ng-ai/openidea");
      expect(statement.predicate.version).toBe("1.2.3");
      expect(statement.predicate.source).toEqual({
        repo: "https://github.com/l0ng-ai/openidea",
        tag: "v1.2.3",
        commit: testCommit,
      });

      for (const [, arch] of supportedTargets) {
        const name = `openidea-linux-${arch}.tar.gz`;
        const artifact = statement.predicate.artifacts.find((item: { name: string }) => item.name === name);
        const subject = statement.subject.find((item: { name: string }) => item.name === name);
        const digest = createHash("sha256")
          .update(readFileSync(archiveFor(dist, arch)))
          .digest("hex");
        expect(artifact).toMatchObject({
          arch,
          bin: ["openidea"],
          format: "tar.gz",
          libc: "gnu",
          name,
          os: "linux",
          requires: { glibc_min: "2.35" },
        });
        expect(subject.digest.sha256).toBe(digest);
      }

      const verifyArgs = [
        "verify",
        bundle,
        "--pubkey",
        join(workspace, "test.pub"),
        "--allow-unlogged",
        ...artifacts.flatMap((path) => ["--artifact", path]),
      ];
      execFileSync(packslip!, verifyArgs, { cwd: workspace });

      const corrupted = archiveFor(dist, "x86_64");
      const bytes = readFileSync(corrupted);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      writeFileSync(corrupted, bytes);
      const rejected = spawnSync(packslip!, verifyArgs, { cwd: workspace, encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
    },
  );
});
