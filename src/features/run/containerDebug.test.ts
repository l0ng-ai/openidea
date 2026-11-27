import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { containerDebugLaunch, debugpyReady } from "./containerDebug";

describe("container debugging", () => {
  it("reads the port and the project folder from the bootstrap's line", () => {
    expect(
      debugpyReady("debugpy is waiting for the debugger on port 41234, project folder /workspaces/my app\r"),
    ).toEqual({
      port: 41234,
      remoteRoot: "/workspaces/my app",
    });
    expect(debugpyReady("waiting for the debugger on port 41234")).toBeNull();
  });

  it("asks the backend for a debug run, keeping the configuration's parameters", () => {
    const config = { id: "a", params: { module: "app" } } as unknown as RunConfig;
    expect(containerDebugLaunch(config).params).toEqual({ module: "app", containerDebug: "true" });
    expect(config.params).toEqual({ module: "app" });
  });
});
