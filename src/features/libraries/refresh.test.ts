import { describe, expect, it, vi } from "vitest";
import type { LibraryGroup } from "@/bindings";

const results: Array<LibraryGroup[] | Promise<LibraryGroup[]>> = [];
const channels: Array<{ onmessage: (groups: LibraryGroup[]) => void }> = [];
let requestId = 0;
/** Batches the next request streams before it answers. */
const streamed: LibraryGroup[][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (v: unknown) => void = () => {};
  },
}));
vi.mock("@/bindings", () => ({
  commands: {
    sdkProjectLibraries: (_id: number, channel: unknown) => ["sdkProjectLibraries", channel],
    cancelRequest: () => Promise.resolve(),
  },
}));
vi.mock("@/platform/ipc", () => ({
  call: (request: [string, (typeof channels)[number]]) => {
    const channel = request[1];
    channels.push(channel);
    for (const batch of streamed.splice(0)) channel.onmessage(batch);
    return Promise.resolve(results.shift() ?? []);
  },
  isCancelled: () => false,
  isTauri: () => true,
  nextRequestId: () => ++requestId,
  onIdeEvent: () => () => {},
}));

const { activate } = await import("./index");
const { useProject } = await import("@/platform/project");
const { useProjectViewRoots } = await import("@/workbench/contributions");
const { executeAction } = await import("@/platform/actions");
const { isLibraryPath } = await import("@/editor/api");

const rust = (version: string): LibraryGroup => ({
  name: "Cargo dependencies",
  kind: "cargo",
  roots: [{ name: `itoa ${version}`, path: `/cargo/itoa-${version}` }],
});

describe("External Libraries refresh", () => {
  it("drops the old project's tree and read-only roots before the next project reports any libraries", async () => {
    const setRoot = (root: string) =>
      useProject.setState({ project: { root, name: root, trusted: true, isGit: false, settings: {} } });
    const rootLabel = () =>
      useProjectViewRoots.getState().roots.get("externalLibraries")?.children?.[0]?.children?.[0]?.label;
    setRoot("/old");
    results.push([rust("1.0.19")]);
    const dispose = activate();
    try {
      await vi.waitFor(() => expect(rootLabel()).toBe("itoa 1.0.19"));
      expect(isLibraryPath("/cargo/itoa-1.0.19/src/lib.rs")).toBe(true);

      let finishOld!: (groups: LibraryGroup[]) => void;
      results.push(new Promise((resolve) => (finishOld = resolve)));
      await executeAction("libraries.reload");
      const old = channels.at(-1)!;
      expect(rootLabel()).toBe("itoa 1.0.19");

      let finishNew!: (groups: LibraryGroup[]) => void;
      results.push(new Promise((resolve) => (finishNew = resolve)));
      setRoot("/new");
      const current = channels.at(-1)!;
      expect(useProjectViewRoots.getState().roots.has("externalLibraries")).toBe(false);
      expect(isLibraryPath("/cargo/itoa-1.0.19/src/lib.rs")).toBe(false);

      old.onmessage([rust("9.0.0")]);
      finishOld([rust("9.0.0")]);
      await Promise.resolve();
      expect(useProjectViewRoots.getState().roots.has("externalLibraries")).toBe(false);

      current.onmessage([
        { name: "Node", kind: "nodeModules", roots: [{ name: "new", path: "/new/node_modules/new" }] },
      ]);
      expect(rootLabel()).toBe("new");
      expect(isLibraryPath("/new/node_modules/new/index.js")).toBe(true);
      expect(isLibraryPath("/cargo/itoa-1.0.19/src/lib.rs")).toBe(false);
      finishNew([rust("2.0.0")]);
      await vi.waitFor(() => expect(rootLabel()).toBe("itoa 2.0.0"));
    } finally {
      dispose();
      useProject.setState({ project: null });
    }
  });

  it("replaces the node in place when the libraries change", async () => {
    useProject.setState({
      project: { root: "/p", trusted: true } as ReturnType<typeof useProject.getState>["project"],
    });
    results.push([rust("1.0.19")]);
    const dispose = activate();
    await vi.waitFor(() => expect(useProjectViewRoots.getState().roots.get("externalLibraries")).toBeTruthy());
    const present: boolean[] = [];
    const stop = useProjectViewRoots.subscribe((s) => present.push(s.roots.has("externalLibraries")));
    // Batches streamed meanwhile, even an empty one, keep what they don't report yet.
    streamed.push([], [{ name: "Rust 1.98.1", kind: "rust", roots: [{ name: "library", path: "/rust/library" }] }]);
    results.push([rust("0.8.0")]);
    await executeAction("libraries.reload");
    await vi.waitFor(() =>
      expect(useProjectViewRoots.getState().roots.get("externalLibraries")?.children?.[0]?.children?.[0]?.label).toBe(
        "itoa 0.8.0",
      ),
    );
    expect(present).not.toContain(false);
    const shown = useProjectViewRoots
      .getState()
      .roots.get("externalLibraries")
      ?.children?.map((g) => g.label);
    expect(shown).toEqual(["Cargo dependencies"]);
    stop();
    dispose();
    expect(useProjectViewRoots.getState().roots.has("externalLibraries")).toBe(false);
  });
});
