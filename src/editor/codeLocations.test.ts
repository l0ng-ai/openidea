import { beforeEach, describe, expect, it, vi } from "vitest";

const openFile = vi.fn(async () => {});
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  maybeEditorService: () => ({ openFile }),
}));

import { isLibraryPath, isLibrarySource, openCodeLocation } from "./api";
import { useProject } from "@/platform/project";

describe("openCodeLocation", () => {
  beforeEach(() => {
    openFile.mockClear();
    useProject.setState({ project: { root: "/work/app" } as never });
  });

  // Where language servers keep the library sources they answer with, outside the project.
  it.each([
    ["Java (java-analyzer cache)", "/Users/me/Library/Caches/java-analyzer/sources/src/fe1e/java/util/ArrayList.java"],
    ["TypeScript (global typescript lib)", "/opt/homebrew/lib/node_modules/typescript/lib/lib.dom.d.ts"],
    [
      "PHP (Intelephense stubs)",
      "/Users/me/Library/Application Support/ide/tools/node_modules/intelephense/lib/stub/standard/standard_2.php",
    ],
    ["Kotlin (kotlin-language-server temp copy)", "/private/var/folders/gx/T/kotlinlangserver1146/LocalDate1643.java"],
    ["Python (interpreter stdlib)", "/Users/me/.pyenv/versions/3.11.5/lib/python3.11/argparse.py"],
  ])("opens a %s target outside the project as a read-only library source", async (_, path) => {
    expect(isLibraryPath(path)).toBe(false);
    await openCodeLocation(path, { line: 3, col: 1 });
    expect(openFile).toHaveBeenCalledWith(path, { selection: { line: 3, col: 1 }, focus: true });
    expect(isLibraryPath(path)).toBe(true);
    expect(isLibrarySource({ path, virtual: false })).toBe(true);
  });

  it("leaves project files and virtual documents editable", async () => {
    for (const path of ["/work/app/src/Main.java", "jdt://contents/rt.jar/java.util/ArrayList.class"]) {
      await openCodeLocation(path, { line: 0, col: 0 });
      expect(isLibraryPath(path)).toBe(false);
    }
  });

  it("does not mark files without an open project", async () => {
    useProject.setState({ project: null });
    await openCodeLocation("/tmp/elsewhere/notes.txt");
    expect(isLibraryPath("/tmp/elsewhere/notes.txt")).toBe(false);
  });

  it("keeps a workspace's other projects editable", async () => {
    useProject.setState({
      project: { root: "/work/app", workspace: { projects: ["/work/app", "/work/lib"] } } as never,
    });
    await openCodeLocation("/work/lib/src/Util.java");
    expect(isLibraryPath("/work/lib/src/Util.java")).toBe(false);
  });
});
