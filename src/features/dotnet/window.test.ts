import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAction } from "@/platform/actions";
import { useContributions } from "@/workbench/contributions";
import { PROJECT_TYPES } from "@/ui/projectType";
import { activate } from "./index";

let dispose: () => void;

beforeEach(() => {
  dispose = activate();
});

afterEach(() => {
  dispose();
});

describe("standalone .NET tool window removal", () => {
  it("registers no .NET tool window (no C# stripe button)", () => {
    expect(useContributions.getState().toolWindows.has("dotnet")).toBe(false);
  });

  it("registers no command that opens it", () => {
    expect(getAction("dotnet.show")).toBeUndefined();
  });

  it("keeps the workbench entry points for .NET operations", () => {
    for (const id of [
      "dotnet.reload",
      "dotnet.build",
      "dotnet.restore",
      "dotnet.clean",
      "dotnet.packages",
      "dotnet.discover",
      "dotnet.test",
      "dotnet.installTrx",
    ]) {
      expect(getAction(id), id).toBeDefined();
    }
  });

  it("keeps .NET solutions and projects visible in the Project tool window's file tree", () => {
    expect(PROJECT_TYPES.dotnet.markers.some((m) => m instanceof RegExp && m.test("App.csproj"))).toBe(true);
    expect(PROJECT_TYPES.dotnet.markers.some((m) => m instanceof RegExp && m.test("App.sln"))).toBe(true);
  });
});
