import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { initProjectTypes } from "./projectTypes";
import { currentModel, initProjectTree, setViewOption, useProjectTree } from "./store";

const backend = vi.hoisted(() => ({ fsReadDir: vi.fn(), fsReadText: vi.fn(), fsProbe: vi.fn() }));
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
  backend.fsReadText.mockReset().mockResolvedValue(ok('{"dependencies":{"react":"19"}}'));
  backend.fsProbe.mockReset().mockRejectedValue(new Error("Not found"));
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
  it("refreshes only affected manifests and removes a deleted framework", async () => {
    initProjectTree("/ws", "Workspace", ["/a", "/b"]);
    await waitFor(() => expect(useProjectTree.getState().projectTypes.size).toBe(2));
    backend.fsReadDir.mockClear();
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: ["/a/README.md"], removed: [] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(backend.fsReadDir).not.toHaveBeenCalled();
    backend.fsReadDir.mockResolvedValue(ok([]));
    emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: ["/a/package.json"] });
    await waitFor(() => expect(useProjectTree.getState().projectTypes.has("/a")).toBe(false));
    expect(useProjectTree.getState().projectTypes.get("/b")).toBe("react");
    expect(backend.fsReadDir).toHaveBeenCalledExactlyOnceWith("/a");
  });
  it("rejects stale reads after switching projects", async () => {
    let finish!: (value: unknown) => void;
    backend.fsReadText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    initProjectTree("/old");
    await waitFor(() => expect(finish).toBeDefined());
    initProjectTree("/new");
    await waitFor(() => expect(useProjectTree.getState().projectTypes.get("/new")).toBe("react"));
    finish(ok('{"dependencies":{"next":"16"}}'));
    await Promise.resolve();
    expect(useProjectTree.getState().projectTypes.has("/old")).toBe(false);
  });
  it("reads a version catalog without traversing sources or dependencies", async () => {
    backend.fsReadDir.mockResolvedValue(
      ok([
        entry("build.gradle.kts"),
        entry("gradle", "dir"),
        entry("node_modules", "dir"),
        entry("src", "dir"),
        entry("package.json", "file", 1024 * 1024),
        entry("README.md"),
      ]),
    );
    backend.fsProbe.mockResolvedValue(ok({ size: 80, binary: false }));
    backend.fsReadText.mockImplementation(async (path: string) =>
      ok(path.endsWith(".toml") ? '[plugins]\ncompose = { id = "org.jetbrains.compose" }' : ""),
    );
    initProjectTree("C:/work/app");
    await waitFor(() => expect(useProjectTree.getState().projectTypes.get("C:/work/app")).toBe("compose"));
    expect(backend.fsReadDir).toHaveBeenCalledExactlyOnceWith("C:/work/app");
    expect(backend.fsReadText.mock.calls.map(([path]) => path).sort()).toEqual([
      "C:/work/app/build.gradle.kts",
      "C:/work/app/gradle/libs.versions.toml",
    ]);
  });
  it("sorts types together, names naturally within a type, and unknown types last", () => {
    dispose();
    initProjectTree("/z-go10", "Workspace", ["/z-go10", "/go2", "/web", "/unknown"]);
    useProjectTree.setState({
      projectTypes: new Map([
        ["/z-go10", "go"],
        ["/go2", "go"],
        ["/web", "next"],
      ]),
    });
    setViewOption("sortBy", "type");
    expect(currentModel().roots.map((n) => n.path)).toEqual(["/go2", "/z-go10", "/web", "/unknown"]);
    setViewOption("sortBy", "name");
    expect(currentModel().roots.map((n) => n.path)).toEqual(["/z-go10", "/go2", "/unknown", "/web"]);
  });
});
