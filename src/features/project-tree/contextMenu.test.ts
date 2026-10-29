import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { resolveMenuItems, type MenuItem } from "@/ui";
import { registerMenuGroup } from "@/workbench/contributions";
import { contextMenuItems, revealLabel } from "./contextMenu";
import type { ProjectNode } from "./model";
import { useProjectTree } from "./store";

const ROOT = "/p";
const SCRATCHES = "/config/scratches";

const node = (path: string, dir = false, root = false): ProjectNode => ({
  key: path,
  path,
  chain: [path],
  label: path.slice(path.lastIndexOf("/") + 1),
  dir,
  root,
  entry: null,
  ignored: false,
  excluded: false,
  symlink: false,
});

/** Labels as the menu shows them ("-" for separators). */
const labels = (items: MenuItem[]) => resolveMenuItems(items).map((r) => (r.kind === "separator" ? "-" : r.label));
const sub = (items: MenuItem[], label: string) => {
  const item = resolveMenuItems(items).find((r) => r.label === label);
  return item?.submenu ? labels(item.submenu) : undefined;
};

const OTHER_ACTIONS = [
  "find.inPath",
  "find.replaceInPath",
  "code.reformatFile",
  "code.optimizeImportsFile",
  "terminal.openAt",
  "vcs.localHistory",
  "localHistory.putLabel",
  "diff.compareWith",
  "diff.compareFiles",
  "vcs.commit",
  "vcs.addToVcs",
  "vcs.annotate",
  "vcs.showDiff",
  "vcs.rollback",
  "vcs.push",
];

let disposers: Array<() => void> = [];

beforeEach(() => {
  useProjectTree.setState({ root: ROOT });
  useProject.setState({
    project: { name: "p", root: ROOT, isGit: true, settings: {} } as never,
    settings: {} as never,
  });
  disposers = [
    registerActions(OTHER_ACTIONS.map((id) => ({ id, title: id, run: () => undefined }))),
    registerMenuGroup({
      id: "test.run",
      menus: ["projectView"],
      items: (_menu, ctx) =>
        ctx.paths.length === 1 && !ctx.dirs?.[0] ? [{ label: "Run 'a'", icon: "run", run: () => undefined }] : [],
    }),
  ];
});

afterEach(() => {
  disposers.forEach((d) => d());
  useProject.setState({ project: null, settings: null });
  useProjectTree.setState({ root: null });
});

describe("project view context menu", () => {
  it("follows IDEA's order for a file", () => {
    const items = contextMenuItems([node(`${ROOT}/src/a.py`)]);
    expect(labels(items)).toEqual([
      "New",
      "-",
      "Cut",
      "Copy",
      "Copy Path/Reference…",
      "Paste",
      "-",
      "Jump to Source",
      "Find Usages",
      "Find in Files…",
      "Replace in Files…",
      "-",
      "Refactor",
      "-",
      "Reformat Code",
      "Optimize Imports",
      "Delete…",
      "-",
      "Run 'a'",
      "-",
      "Open In",
      "-",
      "Local History",
      "Reload from Disk",
      "-",
      "Git",
      "-",
      "Compare With…",
    ]);
    expect(sub(items, "Refactor")).toEqual(["Rename…", "Move File…", "Copy File…", "-", "Safe Delete…"]);
    expect(sub(items, "Open In")).toEqual([revealLabel(), "Terminal"]);
    expect(sub(items, "Git")?.slice(0, 4)).toEqual(["Commit File…", "Add", "-", "Annotate with Git Blame"]);
  });

  it("offers both ignore destinations for files, directories and multi-selection, separately from IDE exclusion", () => {
    const dispose = registerActions(
      ["vcs.ignoreShared", "vcs.ignoreLocal"].map((id) => ({ id, title: id, run: () => undefined })),
    );
    try {
      for (const nodes of [[node("/p/a")], [node("/p/dir", true)], [node("/p/a"), node("/p/dir", true)]]) {
        const git = resolveMenuItems(contextMenuItems(nodes)).find((item) => item.label === "Git")!;
        expect(sub(git.submenu!, "Add to .gitignore")).toEqual([".gitignore", ".git/info/exclude"]);
      }
      const root = resolveMenuItems(contextMenuItems([node("/p", true, true)])).find((item) => item.label === "Git")!;
      expect(labels(root.submenu!)).not.toContain("Add to .gitignore");
      const folder = contextMenuItems([node("/p/dir", true)]);
      expect(sub(folder, "Mark Directory as")).toContain("Excluded");
    } finally {
      dispose();
    }
  });

  it("shows Mark Directory as for folders, without file-only items", () => {
    const l = labels(contextMenuItems([node(`${ROOT}/src`, true)]));
    expect(l).toContain("Mark Directory as");
    expect(sub(contextMenuItems([node(`${ROOT}/src`, true)]), "Refactor")).toContain("Move Directory…");
    for (const fileOnly of ["Find Usages", "Reformat Code", "Optimize Imports", "Compare With…", "Run 'a'"])
      expect(l).not.toContain(fileOnly);
  });

  it("keeps the project root menu short and disables what cannot apply", () => {
    const items = contextMenuItems([node(ROOT, true, true)]);
    const l = labels(items);
    expect(l).not.toContain("Refactor");
    expect(l).not.toContain("Mark Directory as");
    const resolved = resolveMenuItems(items);
    for (const label of ["Cut", "Copy", "Delete…"])
      expect(resolved.find((r) => r.label === label)?.disabled).toBe(true);
  });

  it("drops project-only groups for scratch files", () => {
    const l = labels(contextMenuItems([node(`${SCRATCHES}/s.py`)]));
    expect(l).not.toContain("Git");
    expect(l).not.toContain("Find Usages");
    expect(l).toContain("Refactor");
    expect(l).toContain("Reload from Disk");
  });

  it("offers Compare Files for two files", () => {
    const l = labels(contextMenuItems([node(`${ROOT}/a.py`), node(`${ROOT}/b.py`)]));
    expect(l).toContain("Compare Files");
    expect(l).not.toContain("Compare With…");
  });

  it("never shows an empty submenu", () => {
    disposers.forEach((d) => d());
    disposers = [];
    useProject.setState({
      project: { name: "p", root: ROOT, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    const l = labels(contextMenuItems([node(`${ROOT}/a.py`)]));
    expect(l).not.toContain("Git");
    expect(l).not.toContain("Local History");
    expect(l).not.toContain("Find in Files…");
  });
});
