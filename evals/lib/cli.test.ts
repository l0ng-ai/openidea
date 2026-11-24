import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const runner = resolve(import.meta.dirname, "../run.ts");

describe("eval CLI preflight (no app builds)", () => {
  test.each([
    [["--condition", "hot"], /--condition must be warm or cold/],
    [["--only", "java.app,unknown"], /no scenario matches unknown/],
    [["--only", "java.app,"], /empty selector/],
    [["--only", "java.app.usages", "--condition", "cold"], /no compatible scenario/],
    [["--runs", "0"], /--runs/],
    [["--runs", "Infinity"], /--runs/],
    [["--runs", "1.5"], /--runs/],
    [["--warmup", "NaN"], /--warmup/],
    [["--warmup=-1"], /--warmup/],
  ] as const)("rejects %j before build/start", (args, message) => {
    const result = spawnSync(process.execPath, [runner, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PATH: "", OPENIDEA_SERVER: "/nonexistent/eval-preflight-server" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("Building openidea-server");
  });
});
