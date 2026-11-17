import { describe, expect, it, vi } from "vitest";
import type { LibraryGroup } from "@/bindings";

const results: LibraryGroup[][] = [];
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
  call: (request: [string, { onmessage: (v: unknown) => void }]) => {
    for (const batch of streamed.splice(0)) request[1].onmessage(batch);
    return Promise.resolve(results.shift() ?? []);
  },
  isCancelled: () => false,
  isTauri: () => true,
  nextRequestId: () => 1,
  onIdeEvent: () => () => {},
}));

const { activate } = await import("./index");
const { useProject } = await import("@/platform/project");
const { useProjectViewRoots } = await import("@/workbench/contributions");
const { executeAction } = await import("@/platform/actions");

const rust = (version: string): LibraryGroup => ({
  name: "Cargo dependencies",
  kind: "cargo",
  roots: [{ name: `itoa ${version}`, path: `/cargo/itoa-${version}` }],
});

describe("External Libraries refresh", () => {
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
