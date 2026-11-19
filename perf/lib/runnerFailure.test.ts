// @vitest-environment node
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const repo = resolve(import.meta.dirname, "../..");

test.each([
  { family: "perf", args: ["--only", "typing", "--no-build"], kind: "missing bundle" },
  { family: "perf", args: ["--only", "typing"], kind: "build failure" },
  { family: "perf", args: ["--only", "typing", "--no-build", "--channel", "not-a-browser"], kind: "browser failure" },
  { family: "evals", args: ["--only", "java.app", "--no-build"], kind: "missing server" },
])("$kind replaces old passing reports with structured failure", { timeout: 30_000 }, ({ family, args, kind }) => {
  const root = mkdtempSync(join(tmpdir(), "openidea-runner-failure-"));
  try {
    for (const dir of ["perf", "evals", "smoke"]) cpSync(join(repo, dir), join(root, dir), { recursive: true });
    cpSync(join(repo, "package.json"), join(root, "package.json"));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "junction");
    const output = join(root, "target", family === "perf" ? "perf" : "eval");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "report.json"), '{"pass":true,"sentinel":"old success"}');
    writeFileSync(join(output, "report.md"), "old success");
    if (kind === "browser failure") {
      mkdirSync(join(output, "dist"));
      writeFileSync(join(output, "dist", "index.html"), "<!doctype html><title>launch boundary</title>");
    }
    const result = spawnSync(
      process.execPath,
      [join(root, family, "run.ts"), ...args, "--runs", "1", "--warmup", "0"],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: kind === "build failure" ? "" : process.env.PATH,
          OPENIDEA_SERVER: join(root, "nonexistent-server"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.infrastructure.length).toBeGreaterThan(0);
    expect(report.expected.length).toBeGreaterThan(0);
    expect(report.trials).toEqual({});
    expect(report.sentinel).toBeUndefined();
    if (family === "evals") expect(report.pass).toBe(false);
    else expect(report.failures).toBeGreaterThan(0);
    const markdown = readFileSync(join(output, "report.md"), "utf8");
    expect(markdown).not.toContain("old success");
    expect(markdown).toMatch(/Infrastructure|infrastructure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
