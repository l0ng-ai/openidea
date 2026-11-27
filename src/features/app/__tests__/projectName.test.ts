import { afterEach, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { projectActions } from "../projectActions";
import { installWindowTitle } from "../title";

const { rename, prompt } = vi.hoisted(() => ({ rename: vi.fn(), prompt: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: { projectRename: rename, menuRefresh: vi.fn() },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));
vi.mock("@/workbench/inputDialogs", () => ({ promptInput: prompt }));

afterEach(() => {
  useProject.setState({ project: null, settings: null });
});

it("renames from the primary name while updating the attached window label", async () => {
  const project = {
    root: "/primary",
    name: "primary",
    displayName: "primary, other",
    trusted: true,
    isGit: false,
    settings: {},
    workspace: { version: 1, name: "primary", projects: ["/primary", "/other"] },
  };
  useProject.setState({ project });
  const dispose = installWindowTitle();
  try {
    expect(document.title).toBe("primary, other");
    prompt.mockImplementation(async ({ initial }) => initial);
    rename.mockImplementation(async (name) => ({
      status: "ok",
      data: { ...project, name, displayName: `${name}, other` },
    }));
    await projectActions()
      .find((a) => a.id === "file.renameProject")!
      .run({ ctx: {} });
    expect(rename).toHaveBeenCalledWith("primary");
    expect(document.title).toBe("primary, other");
    prompt.mockResolvedValueOnce("Renamed");
    await projectActions()
      .find((a) => a.id === "file.renameProject")!
      .run({ ctx: {} });
    expect(useProject.getState().project).toMatchObject({ name: "Renamed", displayName: "Renamed, other" });
    expect(document.title).toBe("Renamed, other");
  } finally {
    dispose();
  }
});
