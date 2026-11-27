import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { countOption } from "./options.ts";

const root = resolve(import.meta.dirname, "../..");

describe("benchmark CLI validation", () => {
  it.each([
    ["runs", "NaN"],
    ["runs", "Infinity"],
    ["runs", "0"],
    ["runs", "1.5"],
    ["warmup", "-1"],
    ["warmup", "NaN"],
    ["warmup", "0.5"],
    ["cpu", "NaN"],
    ["cpu", "Infinity"],
    ["cpu", "0"],
  ])("rejects --%s %s before selecting or launching workloads", (option, value) => {
    const result = spawnSync(
      process.execPath,
      ["perf/run.ts", "--no-build", "--only", "__unknown__", `--${option}=${value}`],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--${option} must be`);
    expect(result.stdout).not.toContain("Building");
  });

  it.each(["typing,__unknown__", "", "typing,"])("rejects invalid selection %j", (selection) => {
    const result = spawnSync(process.execPath, ["perf/run.ts", "--no-build", "--only", selection], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown scenario(s)");
  });

  it("accepts integral counts and zero warmup without silently clamping", () => {
    expect(countOption("runs", "5", 1)).toBe(5);
    expect(countOption("warmup", "0", 0)).toBe(0);
    expect(() => countOption("warmup", "", 0)).toThrow();
    expect(() => countOption("runs", "9007199254740992", 1)).toThrow();
  });
});
