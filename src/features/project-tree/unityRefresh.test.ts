import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/bindings";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { activate } from "./index";
import { useProjectTree } from "./store";

const current = vi.hoisted(() => vi.fn());
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      projectCurrent: current,
      projectRoots: async () => ({ status: "ok", data: { roots: [], detected: [] } }),
    },
  };
});

const project = (root = "/game"): ProjectInfo => ({
  root,
  name: "Game",
  trusted: false,
  isGit: false,
  settings: {} as ProjectInfo["settings"],
  unity: { editorVersion: "2022.3.62f1", projects: [], solutions: [] },
});
let dispose: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  current.mockReset();
  useProject.setState({ project: project() });
  dispose = activate();
});
afterEach(() => {
  dispose();
  useProject.setState({ project: null });
  vi.useRealTimers();
});
const changed = () =>
  emitLocalIdeEvent({ type: "fsChanged", created: ["/game/Assembly-CSharp.csproj"], modified: [], removed: [] });

it("refreshes generated C# files through backend events without overwriting a project rename", async () => {
  let resolve!: (value: unknown) => void;
  current.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  changed();
  await vi.advanceTimersByTimeAsync(160);
  expect(current).toHaveBeenCalledTimes(1);
  useProject.setState({ project: { ...project(), name: "Renamed" } });
  resolve({ ...project(), unity: { ...project().unity, projects: ["Assembly-CSharp.csproj"] } });
  await vi.advanceTimersByTimeAsync(0);
  expect(useProjectTree.getState().unity?.projects).toEqual(["Assembly-CSharp.csproj"]);
  expect(useProject.getState().project?.name).toBe("Renamed");
});

it("discards a late reply after switching to another project", async () => {
  let resolve!: (value: unknown) => void;
  current.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  changed();
  await vi.advanceTimersByTimeAsync(160);
  useProject.setState({ project: { ...project("/app"), unity: undefined } });
  resolve(project());
  await vi.advanceTimersByTimeAsync(0);
  expect(useProjectTree.getState()).toMatchObject({ root: "/app", unity: null, mode: "project" });
});
