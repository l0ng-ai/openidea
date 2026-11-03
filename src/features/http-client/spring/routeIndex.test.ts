import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, emitLocalIdeEvent } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
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
});

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
