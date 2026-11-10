import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, emitLocalIdeEvent } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { searchEndpoints } from "@/workbench/contributions";
import { clearRouteIndex, isRouteSource, registerSpringEndpointProvider, routeIndex } from "./routeIndex";

const scanSources = vi.spyOn(commands, "springRouteSources");

const source = (method = "searchMenus", url = "/menu/search") => ({
  path: "/p/DeepLinkController.java",
  text: `@RestController
@RequestMapping("/deeplink")
class DeepLinkController {
    @PostMapping("${url}")
    String ${method}() { return "ok"; }
}`,
});

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  clearRouteIndex();
  scanSources.mockReset();
  useProject.setState({ project: null });
});

function workspace(projects: string[]) {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: {},
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects },
    },
  });
}

describe("the request-path index follows the workspace", () => {
  it("is invalidated by a change to a mapping source", () => {
    for (const [path, expected] of [
      ["/p/A.java", true],
      ["/p/B.kt", true],
      ["/p/C.kts", true],
      ["/p/pom.xml", false],
      ["/p/notes.md", false],
    ] as const) {
      expect(isRouteSource(path), path).toBe(expected);
    }
  });
});

describe("the Spring endpoint provider", () => {
  it("includes linked members with member-relative paths and excludes files outside every member", async () => {
    workspace(["/p", "/linked", "/linked/nested"]);
    scanSources.mockResolvedValue({
      status: "ok",
      data: [
        source(),
        { ...source(), path: "/linked/src/Controller.kt" },
        { ...source(), path: "/linked/nested/src/NestedController.java" },
        { ...source(), path: "/linked-other/Outside.java" },
        { ...source(), path: "/workspace/State.java" },
      ],
    });
    expect(await routeIndex("/workspace")).toMatchObject([
      { path: "/p/DeepLinkController.java", rel: "DeepLinkController.java", line: 4, col: 11 },
      { path: "/linked/src/Controller.kt", rel: "src/Controller.kt", line: 4, col: 11 },
      { path: "/linked/nested/src/NestedController.java", rel: "src/NestedController.java" },
    ]);
  });

  it("rescans when members are added or removed without changing the workspace root", async () => {
    scanSources.mockResolvedValue({
      status: "ok",
      data: [source(), { ...source(), path: "/linked/Controller.java" }],
    });
    workspace(["/p"]);
    expect(await routeIndex("/workspace")).toHaveLength(1);
    workspace(["/p", "/linked"]);
    const both = await routeIndex("/workspace");
    expect(both).toHaveLength(2);
    expect(await routeIndex("/workspace")).toBe(both);
    workspace(["/linked"]);
    expect(await routeIndex("/workspace")).toMatchObject([{ path: "/linked/Controller.java" }]);
    workspace([]);
    expect(await routeIndex("/workspace")).toEqual([]);
    expect(scanSources).toHaveBeenCalledTimes(4);
  });

  it("scans once per root with method coordinates and rescans for another root", async () => {
    scanSources.mockResolvedValue({ status: "ok", data: [source()] });
    expect(await routeIndex(null)).toEqual([]);
    const first = await routeIndex("/p");
    expect(first).toEqual([
      {
        method: "POST",
        url: "/deeplink/menu/search",
        controller: "DeepLinkController",
        methodName: "searchMenus",
        path: "/p/DeepLinkController.java",
        rel: "DeepLinkController.java",
        line: 4,
        col: 11,
      },
    ]);
    expect(await routeIndex("/p")).toBe(first);
    expect(scanSources).toHaveBeenCalledTimes(1);
    expect(await routeIndex("/other")).toEqual([]);
    expect(scanSources).toHaveBeenCalledTimes(2);
  });

  it("matches sources by path segments, whatever separator the host used", async () => {
    scanSources.mockResolvedValue({
      status: "ok",
      data: [
        { ...source(), path: "D:\\work\\demo\\src\\DeepLinkController.java" },
        { ...source("other"), path: "D:/work/demo2/DeepLinkController.java" },
      ],
    });
    expect(await routeIndex("D:/work/demo")).toMatchObject([
      {
        methodName: "searchMenus",
        path: "D:/work/demo/src/DeepLinkController.java",
        rel: "src/DeepLinkController.java",
      },
    ]);
  });

  it.each(["created", "modified", "removed"] as const)("invalidates on %s mapping sources", async (kind) => {
    scanSources.mockResolvedValue({ status: "ok", data: [source()] });
    dispose = registerSpringEndpointProvider();
    expect((await searchEndpoints("/p"))[0]?.methodName).toBe("searchMenus");
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [ipcPath("/p/pom.xml")], removed: [] });
    await searchEndpoints("/p");
    expect(scanSources).toHaveBeenCalledTimes(1);
    scanSources.mockResolvedValue({ status: "ok", data: [source("listMenus", "/menu/list")] });
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: [], [kind]: [ipcPath("/p/A.java")] });
    expect((await searchEndpoints("/p"))[0]?.url).toBe("/deeplink/menu/list");
    expect(scanSources).toHaveBeenCalledTimes(2);
    dispose();
    expect(await searchEndpoints("/p")).toEqual([]);
  });
});
