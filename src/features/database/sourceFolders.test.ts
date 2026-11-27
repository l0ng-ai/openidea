import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { createSourceFolder, deleteSourceFolder, moveSourcesToFolder, renameSourceFolder, useDatabase } from "./store";

const sources = ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), driver: "postgres" as const }));

beforeEach(() => {
  useProject.setState({ project: { name: "p", root: "/p", trusted: true } as never });
  useDatabase.setState({
    loaded: true,
    foldersLoaded: true,
    sources,
    folders: [],
    treeExpanded: new Set(),
  });
  vi.spyOn(commands, "dbSaveSourceFolders").mockResolvedValue({ status: "ok", data: null });
});

describe("data source folders", () => {
  it("creates, renames, moves and deletes folders while keeping sources out of several folders", async () => {
    const id = await createSourceFolder("Production", ["a", "b"]);
    expect(id).toBeTruthy();
    expect(useDatabase.getState().folders).toEqual([
      expect.objectContaining({ id, name: "Production", sources: ["a", "b"] }),
    ]);

    expect(await renameSourceFolder(id!, "Live")).toBe(true);
    expect(useDatabase.getState().folders[0]!.name).toBe("Live");

    expect(await moveSourcesToFolder(["c"], id)).toBe(true);
    expect(useDatabase.getState().folders[0]!.sources).toEqual(["a", "b", "c"]);

    expect(await moveSourcesToFolder(["b"], null)).toBe(true);
    expect(useDatabase.getState().folders[0]!.sources).toEqual(["a", "c"]);

    expect(await deleteSourceFolder(id!)).toBe(true);
    expect(useDatabase.getState().folders).toEqual([]);
    expect(vi.mocked(commands.dbSaveSourceFolders)).toHaveBeenCalledTimes(5);
  });

  it("gives duplicate folder names a suffix and expands a newly populated folder", async () => {
    const first = await createSourceFolder("Test", ["a"]);
    const second = await createSourceFolder("Test", ["b"]);
    expect(first).not.toBe(second);
    expect(useDatabase.getState().folders.map((folder) => folder.name)).toEqual(["Test", "Test (2)"]);
    expect(useDatabase.getState().treeExpanded.has(`source-folder:${second}`)).toBe(true);
  });
});
