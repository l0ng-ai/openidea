import { afterEach, describe, expect, it } from "vitest";
import { pathToCopy } from "./copyPath";
import { useProject } from "./project";
import { useProjectRoots } from "./projectRoots";

afterEach(() => {
  useProject.setState({ project: null, settings: null });
  useProjectRoots.setState({ root: null, detected: [] });
});

describe("shared copy path values", () => {
  it("preserves root, outside paths and Windows IPC paths", () => {
    expect(pathToCopy("absolute", "/p/a.ts", "/p")).toBe("/p/a.ts");
    expect(pathToCopy("name", "/p/a.ts", "/p")).toBe("a.ts");
    expect(pathToCopy("relative", "/p/src/a.ts", "/p")).toBe("src/a.ts");
    expect(pathToCopy("relative", "/p", "/p")).toBe(".");
    expect(pathToCopy("relative", "/project/a.ts", "/p")).toBe("/project/a.ts");
    expect(pathToCopy("relative", "/src/a.ts", "/")).toBe("src/a.ts");
    expect(pathToCopy("relative", "C:/p/src/a.ts", "C:/p")).toBe("src/a.ts");
  });

  it("writes absolute Windows paths with backslashes", () => {
    expect(pathToCopy("absolute", "C:/work/shop/docs/api.md", "C:/work/shop")).toBe("C:\\work\\shop\\docs\\api.md");
    expect(pathToCopy("absolute", "//server/share/a.ts", "//server/share")).toBe("\\\\server\\share\\a.ts");
    expect(pathToCopy("absolute", "//?/UNC/server/share/a.ts", null)).toBe("\\\\server\\share\\a.ts");
    expect(pathToCopy("absolute", "//?/C:/p/a.ts", null)).toBe("C:\\p\\a.ts");
    // Outside the content root a relative copy falls back to the absolute path.
    expect(pathToCopy("relative", "D:/other/a.ts", "C:/p")).toBe("D:\\other\\a.ts");
    // Relative paths keep `/`, like IDEA's Path From Content Root.
    expect(pathToCopy("relative", "C:/p/src/a.ts", "C:/p")).toBe("src/a.ts");
    // Remote and POSIX paths stay as they are.
    expect(pathToCopy("absolute", "/home/me/a.ts", "/home/me")).toBe("/home/me/a.ts");
  });

  it("uses the containing workspace folder as the content root", () => {
    useProject.setState({ project: { root: "/workspace", workspace: { projects: ["/a", "/b"] } } as never });
    expect(pathToCopy("relative", "/b/src/a.ts")).toBe("src/a.ts");
    expect(pathToCopy("relative", "/outside/a.ts")).toBe("/outside/a.ts");
  });

  it("uses effective nested source, test and resource roots and respects exclusions", () => {
    useProject.setState({
      project: { root: "/p" } as never,
      settings: { projectStructure: { sourceRoots: ["generated"], unmarked: ["src/old"] } } as never,
    });
    useProjectRoots.setState({
      root: "/p",
      detected: [
        { path: "src", kind: "source", detectedFrom: null },
        { path: "src/test", kind: "test", detectedFrom: null },
        { path: "res", kind: "resources", detectedFrom: null },
        { path: "src/out", kind: "excluded", detectedFrom: null },
        { path: "src/old", kind: "source", detectedFrom: null },
      ],
    });
    expect(pathToCopy("source", "/p/src/a.ts")).toBe("a.ts");
    expect(pathToCopy("source", "/p/src/test/a.ts")).toBe("a.ts");
    expect(pathToCopy("source", "/p/res/config.json")).toBe("config.json");
    expect(pathToCopy("source", "/p/generated/a.ts")).toBe("a.ts");
    expect(pathToCopy("source", "/p/src/old/a.ts")).toBe("old/a.ts");
    for (const path of ["/p/src/out/a.ts", "/p/src-other/a.ts", "/outside/a.ts"])
      expect(pathToCopy("source", path)).toBeNull();
  });
});
