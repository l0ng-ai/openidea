import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { isZigBuildStep, zigDebugTarget } from "./zigDebug";

const config = (over: Partial<RunConfig> = {}): RunConfig =>
  ({
    id: "zig:run",
    name: "zig build run",
    kind: "zig",
    command: "zig",
    args: ["build", "run"],
    detected: true,
    debugAdapter: null,
    isTest: false,
    env: {},
    cwd: null,
    ...over,
  }) as RunConfig;

const exe = (id: string, over: Partial<RunConfig> = {}): RunConfig =>
  config({
    id,
    name: id,
    kind: "zig-application",
    command: "./zig-out/bin/app",
    args: [],
    debugAdapter: "codelldb",
    ...over,
  });

describe("debugging a Zig build step", () => {
  it("recognises detected build steps, but not the build, tests or executables", () => {
    expect(isZigBuildStep(config())).toBe(true);
    expect(isZigBuildStep(config({ id: "zig:serve", args: ["build", "serve"] }))).toBe(true);
    expect(isZigBuildStep(config({ id: "zig:test", args: ["build", "test"], isTest: true }))).toBe(false);
    expect(isZigBuildStep(config({ id: "zig:build", args: ["build"] }))).toBe(false);
    expect(isZigBuildStep(config({ detected: false }))).toBe(false);
    expect(isZigBuildStep(exe("zig:exe:app"))).toBe(false);
  });

  it("never sends a test step to the app binary", () => {
    const test = config({ id: "zig:test", args: ["build", "test"], isTest: true });
    expect(zigDebugTarget(test, [exe("zig:exe:app")])).toBeNull();
  });

  it("delegates to the executable the backend linked via debugTarget", () => {
    const step = config({ params: { debugTarget: "zig:exe:two" } });
    const configs = [exe("zig:exe:one"), exe("zig:exe:two")];
    expect(zigDebugTarget(step, configs)?.id).toBe("zig:exe:two");
  });

  it("does not guess which executable to debug when there is no link", () => {
    expect(zigDebugTarget(config(), [exe("zig:exe:app")])).toBeNull();
    expect(zigDebugTarget(config(), [exe("zig:exe:one"), exe("zig:exe:two")])).toBeNull();
  });

  it("ignores a stale or non-debuggable link", () => {
    expect(zigDebugTarget(config({ params: { debugTarget: "zig:exe:gone" } }), [exe("zig:exe:app")])).toBeNull();
    expect(
      zigDebugTarget(config({ params: { debugTarget: "zig:exe:app" } }), [exe("zig:exe:app", { debugAdapter: null })]),
    ).toBeNull();
  });

  it("returns null when the project has no debuggable Zig executable", () => {
    expect(zigDebugTarget(config(), [])).toBeNull();
    expect(zigDebugTarget(config(), [exe("zig:exe:app", { debugAdapter: null })])).toBeNull();
  });
});
