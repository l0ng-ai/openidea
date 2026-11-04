import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext } from "./context";
import { executeAction, isActionKeyEnabled, registerAction } from "./actions";
import { commands } from "./ipc";
import { openProject, relativeDir, useProject } from "./project";
import { confirmProjectTrust } from "./projectTrust";

vi.mock("./projectTrust", () => ({ confirmProjectTrust: vi.fn(async () => {}) }));
vi.mock("./ipc", async (original) => ({
  ...(await original<typeof import("./ipc")>()),
  commands: { openProject: vi.fn(), projectCurrent: vi.fn() },
}));

type BackendProject = NonNullable<Awaited<ReturnType<typeof commands.projectCurrent>>>;
const old: BackendProject = {
  root: "/old",
  name: "old",
  trusted: true,
  isGit: false,
  settings: {} as BackendProject["settings"],
};
const next: BackendProject = { ...old, root: "/new", name: "new" };

beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: old, settings: old.settings, lightEdit: false, opening: false, openingPath: null });
});
afterEach(() => useProject.setState({ project: null, settings: null, opening: false, openingPath: null }));

it("shows the target while opening and blocks actions from both menus and shortcuts", async () => {
  let finish!: (value: Awaited<ReturnType<typeof commands.openProject>>) => void;
  vi.mocked(commands.openProject).mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const opening = openProject(next.root);
  await Promise.resolve();
  expect(useProject.getState()).toMatchObject({ project: old, opening: true, openingPath: next.root });
  const run = vi.fn();
  const action = { id: "test.projectMutation", title: "test", run };
  const dispose = registerAction(action);
  try {
    expect(isActionKeyEnabled(action)).toBe(false);
    expect(await executeAction(action.id)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(isActionKeyEnabled({ ...action, id: "app.quit" })).toBe(true);
    finish({ status: "ok", data: next });
    await opening;
    expect(useProject.getState()).toMatchObject({ project: next, opening: false, openingPath: null });
    expect(getContext().projectOpening).toBe(false);
    expect(await executeAction(action.id)).toBe(true);
  } finally {
    dispose();
  }
});

it.each([old, null, next])("reconciles a failed open with the backend's remaining project: %s", async (current) => {
  vi.mocked(commands.openProject).mockRejectedValue(new Error("cannot open project"));
  vi.mocked(commands.projectCurrent).mockResolvedValue(current && { ...current });
  await expect(openProject(next.root)).rejects.toThrow("cannot open project");
  expect(useProject.getState()).toMatchObject({ project: current, opening: false, openingPath: null });
  if (current === old) expect(useProject.getState().project).toBe(old);
});

it("leaves the current project alone when trust is cancelled", async () => {
  vi.mocked(confirmProjectTrust).mockRejectedValueOnce(new Error("cancelled"));
  await expect(openProject(next.root)).rejects.toThrow("cancelled");
  expect(commands.openProject).not.toHaveBeenCalled();
  expect(useProject.getState()).toMatchObject({ project: old, opening: false, openingPath: null });
});

describe("relativeDir", () => {
  it("is empty for files directly in the project root", () => {
    expect(relativeDir("/p/app", "/p/app/README.md")).toBe("");
  });
  it("is project-relative for nested files", () => {
    expect(relativeDir("/p/app", "/p/app/src/lib/a.ts")).toBe("src/lib");
  });
  it("keeps the absolute directory outside the project", () => {
    expect(relativeDir("/p/app", "/other/x.ts")).toBe("/other");
  });
});
