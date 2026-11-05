import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "@/bindings";
import { DEFAULT_TREE_OPTIONS, visibleEntries } from "./model";
import { currentModel, initProjectTree, modeShows, setViewMode, useProjectTree } from "./store";

const unity = { editorVersion: "2022.3.62f1", solutions: [], projects: [] };
const entry = (path: string, dir = false): FileEntry => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: dir ? "dir" : "file",
  size: 1,
  mtimeMs: null,
  ignored: false,
  excluded: false,
  hidden: false,
});
const files = [
  entry("/game/Assets", true),
  entry("/game/Packages", true),
  entry("/game/ProjectSettings", true),
  entry("/game/Library", true),
  entry("/game/Temp", true),
  entry("/game/Assets.meta"),
  entry("/game/Game.sln"),
  entry("/game/Assembly-CSharp.csproj"),
  entry("/game/README.md"),
];

beforeEach(() => {
  localStorage.clear();
  initProjectTree(null);
  setViewMode("project");
});
afterEach(() => initProjectTree(null));

describe("Unity project view", () => {
  it("opens in Unity mode and keeps the full project view available", () => {
    initProjectTree("/game", "Game", null, unity);
    useProjectTree.setState({ listings: new Map([["/game", files]]) });
    expect(useProjectTree.getState().mode).toBe("unity");
    const model = currentModel();
    expect(model.roots[0]?.detail).toBe("Unity 2022.3.62f1");
    expect(model.children.get("/game")?.map((n) => n.label)).toEqual([
      "Assets",
      "Packages",
      "ProjectSettings",
      "README.md",
    ]);
    setViewMode("projectFiles");
    expect(currentModel().children.get("/game")).toHaveLength(files.length);
  });

  it("does not leak Unity mode or metadata into the next ordinary project", () => {
    initProjectTree("/game", "Game", null, unity);
    initProjectTree("/app", "App");
    expect(useProjectTree.getState()).toMatchObject({ mode: "project", unity: null });
    setViewMode("unity");
    expect(useProjectTree.getState().mode).toBe("project");
  });

  it("hides only root caches, keeps asset folders with matching names, and can reveal metadata", () => {
    const options = { ...DEFAULT_TREE_OPTIONS, unityRoot: "/game" };
    const entries = [entry("/game/Assets/Library", true), entry("/game/Assets/P.cs.meta"), entry("/other/P.cs.meta")];
    expect(visibleEntries(entries, options).map((e) => e.path)).toEqual(["/game/Assets/Library", "/other/P.cs.meta"]);
    expect(visibleEntries(entries, { ...options, showHidden: true })).toHaveLength(2);
    expect(visibleEntries(entries, { ...options, showUnityMeta: true })).toHaveLength(3);
    expect(visibleEntries(files, { ...options, showUnityGenerated: true }).map((e) => e.name)).toContain("Library");
    expect(visibleEntries(files, { ...options, showUnityGenerated: true }).map((e) => e.name)).toContain("Game.sln");
    expect(visibleEntries(files, DEFAULT_TREE_OPTIONS)).toHaveLength(files.length);
  });

  it("keeps navigation to unloaded scripts in Unity mode", () => {
    initProjectTree("/game", "Game", null, unity);
    expect(modeShows("/game/Assets/Scripts/Player.cs")).toBe(true);
    expect(modeShows("/game/Library/Cached.cs")).toBe(false);
    expect(modeShows("/game/Assets/Player.cs.meta")).toBe(false);
  });
});
