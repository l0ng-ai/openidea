import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { initProjectTypes } from "./projectTypes";
import { currentModel, initProjectTree, setViewOption, useProjectTree } from "./store";

const backend = vi.hoisted(() => ({ fsReadDir: vi.fn(), fsReadText: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: backend,
}));
const ok = <T>(data: T) => ({ status: "ok", data });
const entry = (name: string, kind = "file", size = 10) => ({ name, kind, size });
let dispose: () => void;

beforeEach(() => {
  backend.fsReadDir.mockReset().mockResolvedValue(ok([entry("package.json")]));
  backend.fsReadText.mockReset();
  initProjectTree(null);
  setViewOption("sortBy", "name");
  dispose = initProjectTypes();
});
afterEach(() => {
  dispose();
  initProjectTree(null);
});

describe("automatic project types", () => {
  it("detects every workspace member with at most four concurrent root reads", async () => {
    const pending: Array<() => void> = [];
    backend.fsReadDir.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(ok([entry("go.mod")])))),
    );
    initProjectTree(
      "/ws",
      "Workspace",
      Array.from({ length: 9 }, (_, i) => `/p${i}`),
    );
    expect(backend.fsReadDir).toHaveBeenCalledTimes(4);
    while (useProjectTree.getState().projectTypes.size < 9) {
      pending.splice(0).forEach((resolve) => resolve());
      await waitFor(() => expect(pending.length || useProjectTree.getState().projectTypes.size === 9).toBeTruthy());
    }
    expect([...useProjectTree.getState().projectTypes.values()]).toEqual(Array(9).fill("go"));
    expect(backend.fsReadDir).toHaveBeenCalledTimes(9);
  });
  it("leaves a single project root alone", async () => {
    initProjectTree("/app");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.fsReadDir).not.toHaveBeenCalled();
    expect(useProjectTree.getState().projectTypes.size).toBe(0);
  });
  it("refreshes only affected markers and clears a removed project type", async () => {
    initProjectTree("/ws", "Workspace", ["/a", "/b"]);
    await waitFor(() => expect(useProjectTree.getState().projectTypes.size).toBe(2));
    backend.fsReadDir.mockClear();
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: ["/a/README.md"], removed: [] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(backend.fsReadDir).not.toHaveBeenCalled();
    backend.fsReadDir.mockResolvedValue(ok([]));
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: ["/a/package.json"] });
    await waitFor(() => expect(useProjectTree.getState().projectTypes.has("/a")).toBe(false));
    expect(useProjectTree.getState().projectTypes.get("/b")).toBe("node");
    expect(backend.fsReadDir).toHaveBeenCalledExactlyOnceWith("/a");
  });
  it("rejects stale reads after switching projects", async () => {
    let finish!: (value: unknown) => void;
    backend.fsReadDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    initProjectTree("/old", "Old", ["/old"]);
    await waitFor(() => expect(finish).toBeDefined());
    initProjectTree("/new", "New", ["/new"]);
    await waitFor(() => expect(useProjectTree.getState().projectTypes.get("/new")).toBe("node"));
    finish(ok([entry("pom.xml")]));
    await Promise.resolve();
    expect(useProjectTree.getState().projectTypes.has("/old")).toBe(false);
  });
  it("only lists root names without reading manifests or traversing directories", async () => {
    backend.fsReadDir.mockResolvedValue(
      ok([
        entry("build.gradle.kts", "file", 1024 * 1024),
        entry("gradle", "dir"),
        entry("node_modules", "dir"),
        entry("src", "dir"),
        entry("package.json", "file", 1024 * 1024),
        entry("README.md"),
      ]),
    );
    initProjectTree("C:/work", "Work", ["C:/work/app"]);
    await waitFor(() => expect(useProjectTree.getState().projectTypes.get("C:/work/app")).toBe("gradle"));
    expect(backend.fsReadDir).toHaveBeenCalledExactlyOnceWith("C:/work/app");
    expect(backend.fsReadText).not.toHaveBeenCalled();
  });
  it("sorts types together, names naturally within a type, and unknown types last", () => {
    dispose();
    initProjectTree("/go10", "Workspace", ["/go10", "/go2", "/web", "/unknown"]);
    useProjectTree.setState({
      projectTypes: new Map([
        ["/go10", "go"],
        ["/go2", "go"],
        ["/web", "node"],
      ]),
    });
    setViewOption("sortBy", "type");
    expect(currentModel().roots.map((n) => n.path)).toEqual(["/go2", "/go10", "/web", "/unknown"]);
    setViewOption("sortBy", "name");
    expect(currentModel().roots.map((n) => n.path)).toEqual(["/go10", "/go2", "/unknown", "/web"]);
  });
  it("ignores marker-named directories and accepts a symlink to a marker file", async () => {
    backend.fsReadDir.mockResolvedValue(
      ok([
        entry("go.mod", "dir"),
        entry("build.gradle.kts", "dir"),
        { ...entry("package.json", "symlink"), targetKind: "file" },
      ]),
    );
    initProjectTree("/ws", "Workspace", ["/linked"]);
    await waitFor(() => expect(useProjectTree.getState().projectTypes.get("/linked")).toBe("node"));
  });
});
