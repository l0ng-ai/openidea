import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction } from "@/platform/actions";
import {
  provideToolWindowService,
  useContributions,
  menuGroupItems,
  type ToolWindowService,
} from "@/workbench/contributions";
import { PROJECT_TYPES } from "@/ui/projectType";
import { activate } from "./index";
import * as store from "./store";

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
      "dotnet.search",
      "dotnet.packageChange",
      "dotnet.discover",
      "dotnet.test",
      "dotnet.installTrx",
    ]) {
      expect(getAction(id), id).toBeDefined();
    }
  });

  it("registers the NuGet tool window on the bottom stripe, listed only on use", () => {
    const nuget = useContributions.getState().toolWindows.get("nuget");
    expect(nuget, "nuget").toBeDefined();
    expect(nuget!.anchor).toBe("bottom");
    expect(nuget!.stripe).toBe("onUse");
  });

  it("dotnet.packages opens the NuGet window", async () => {
    const show = vi.fn();
    provideToolWindowService({ show } as unknown as ToolWindowService);
    const list = vi.spyOn(store, "listPackages").mockReturnValue(undefined);
    await getAction("dotnet.packages")!.run({ ctx: {} });
    expect(show).toHaveBeenCalledWith("nuget", true);
    expect(list).toHaveBeenCalled();
  });

  it("offers Build / Restore / Clean for a solution or project file in the Project view context menu", () => {
    const actions = (path: string) =>
      menuGroupItems("projectView", { paths: [path], dirs: [false] }).map((i) =>
        i.kind === "action" ? `${i.action} ${String(i.arg)}` : i.kind,
      );
    expect(actions("/repo/src/App/App.csproj")).toEqual([
      "dotnet.build /repo/src/App/App.csproj",
      "dotnet.restore /repo/src/App/App.csproj",
      "dotnet.clean /repo/src/App/App.csproj",
      "separator",
    ]);
    expect(actions("/repo/Demo.sln")).toEqual([
      "dotnet.build /repo/Demo.sln",
      "dotnet.restore /repo/Demo.sln",
      "dotnet.clean /repo/Demo.sln",
      "separator",
    ]);
    expect(actions("/repo/src/App/Program.cs")).toEqual([]);
  });

  it("keeps .NET solutions and projects visible in the Project tool window's file tree", () => {
    expect(PROJECT_TYPES.dotnet.markers.some((m) => m instanceof RegExp && m.test("App.csproj"))).toBe(true);
    expect(PROJECT_TYPES.dotnet.markers.some((m) => m instanceof RegExp && m.test("App.sln"))).toBe(true);
  });
});
