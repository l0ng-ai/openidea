import { clearContext, setContext } from "@/platform/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
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
  "diff.compareDirectories",
  "vcs.commit",
  "vcs.addToVcs",
  "vcs.annotate",
  "vcs.showDiff",
  "vcs.compareWithBranch",
  "vcs.compareWithRevision",
  "vcs.showCurrentRevision",
  "vcs.rollback",
  "vcs.push",
];

let disposers: Array<() => void> = [];

beforeEach(() => {
  useProjectTree.setState({ root: ROOT });
  useProject.setState({
    project: { name: "p", root: ROOT, trusted: true, isGit: true, settings: {} } as never,
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
  useRemote.setState({ session: null });
});

describe("project view context menu", () => {
  it("offers directory comparison only for two folders and Compare With for a single folder", () => {
    expect(labels(contextMenuItems([node("/p/left", true), node("/p/right", true)]))).toContain("Compare Directories");
    expect(labels(contextMenuItems([node("/p/left", true)]))).toContain("Compare With…");
    const mixed = labels(contextMenuItems([node("/p/left", true), node("/p/a.txt")]));
    for (const label of ["Compare Directories", "Compare Files", "Compare With…"]) expect(mixed).not.toContain(label);
    expect(labels(contextMenuItems([node("/p/a.txt"), node("/p/b.txt")]))).toContain("Compare Files");
  });

  it("offers Git for repositories found below a non-Git project root", () => {
    useProject.setState({ project: { name: "p", root: ROOT, trusted: true, isGit: false, settings: {} } as never });
    expect(sub(contextMenuItems([node("/p/a.py")]), "Git")).toBeUndefined();
    setContext("vcsAvailable", true);
    try {
      expect(sub(contextMenuItems([node("/p/a.py")]), "Git")).toContain("Commit File…");
    } finally {
      clearContext("vcsAvailable");
    }
  });

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

  it("hides the OS file manager in an SSH or dev-container window, whose files are not on this desktop", () => {
    const library = { ...node("/root/.m2/lib.jar"), readOnly: true };
    expect(sub(contextMenuItems([library]), "Open In")).toEqual([revealLabel()]);
    for (const target of [
      { kind: "ssh", config: "box" },
      { kind: "devContainer", folder: "/Users/me/app", config: "" },
    ] as const) {
      useRemote.setState({ session: { target, root: ROOT, host: "h", os: "linux", commands: [] } });
      expect(sub(contextMenuItems([node(`${ROOT}/src/a.py`)]), "Open In")).toEqual(["Terminal"]);
      expect(labels(contextMenuItems([library]))).not.toContain("Open In");
    }
  });

  it("offers file revision actions only for a single file", () => {
    expect(sub(contextMenuItems([node("/p/a.py")]), "Git")).toEqual(
      expect.arrayContaining(["Compare with Revision…", "Show Current Revision"]),
    );
    for (const nodes of [[node("/p/src", true)], [node("/p/a.py"), node("/p/b.py")]]) {
      expect(sub(contextMenuItems(nodes), "Git")).not.toContain("Compare with Revision…");
      expect(sub(contextMenuItems(nodes), "Git")).not.toContain("Show Current Revision");
    }
  });

  it("offers branch comparison for files, folders, their union and the project root", () => {
    for (const nodes of [
      [node("/p/a.py")],
      [node("/p/src", true)],
      [node("/p/src", true), node("/p/lib", true)],
      [node("/p", true, true)],
    ]) {
      expect(sub(contextMenuItems(nodes), "Git")).toContain("Compare with Branch…");
    }
  });

  it("offers Show History for files, directories, multi-selection and the project root", () => {
    const dispose = registerActions([{ id: "vcs.showHistory", title: "Show History", run: () => undefined }]);
    try {
      for (const nodes of [
        [node("/p/a.py")],
        [node("/p/src", true)],
        [node("/p/a.py"), node("/p/src", true)],
        [node("/p", true, true)],
      ]) {
        expect(sub(contextMenuItems(nodes), "Git")).toContain("Show History");
      }
    } finally {
      dispose();
    }
  });

  it("shows Mark Directory as for folders, without file-only items", () => {
    const l = labels(contextMenuItems([node(`${ROOT}/src`, true)]));
    expect(l).toContain("Mark Directory as");
    expect(sub(contextMenuItems([node(`${ROOT}/src`, true)]), "Refactor")).toContain("Move Directory…");
    for (const fileOnly of ["Find Usages", "Reformat Code", "Optimize Imports", "Run 'a'"])
      expect(l).not.toContain(fileOnly);
  });

  it("offers Import Module from Existing Sources on the project root only", () => {
    const off = registerActions([
      { id: "maven.importExternal", title: "Import Module from Existing Sources", run: () => undefined },
    ]);
    try {
      expect(labels(contextMenuItems([node(ROOT, true, true)]))).toContain("Import Module from Existing Sources");
      expect(labels(contextMenuItems([node(`${ROOT}/src`, true)]))).not.toContain(
        "Import Module from Existing Sources",
      );
    } finally {
      off();
    }
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

  it("offers Compare With… in a non-git project too", () => {
    useProject.setState({
      project: { name: "p", root: ROOT, trusted: true, isGit: false, settings: {} } as never,
      settings: {} as never,
    });
    const l = labels(contextMenuItems([node(`${ROOT}/a.py`)]));
    expect(l).not.toContain("Git");
    expect(l).toContain("Compare With…");
    expect(labels(contextMenuItems([node(`${ROOT}/a.py`), node(`${ROOT}/b.py`)]))).toContain("Compare Files");
  });

  it("never shows an empty submenu", () => {
    disposers.forEach((d) => d());
    disposers = [];
    useProject.setState({
      project: { name: "p", root: ROOT, trusted: true, isGit: true, settings: {} } as never,
      settings: {} as never,
    });
    const l = labels(contextMenuItems([node(`${ROOT}/a.py`)]));
    expect(l).not.toContain("Git");
    expect(l).not.toContain("Local History");
    expect(l).not.toContain("Find in Files…");
  });
});

it("offers workspace removal for every member root", () => {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "A",
      settings: {},
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "A", projects: ["/a", "/b"] },
    },
  });
  const removal = {
    kind: "action",
    action: "workspace.removeProject",
    arg: "/b",
  };
  expect(contextMenuItems([node("/b", true, true)])).toContainEqual(removal);
  expect(contextMenuItems([node("/a", true, true)])).toContainEqual(
    expect.objectContaining({ action: "workspace.removeProject" }),
  );
  expect(contextMenuItems([node("/b/src", true)])).not.toContainEqual(
    expect.objectContaining({ action: "workspace.removeProject" }),
  );
});

it("does not offer removal on the attached primary", () => {
  useProject.setState({
    project: {
      root: "/a",
      name: "A",
      displayName: "A, b",
      trusted: true,
      isGit: false,
      settings: {},
      workspace: { version: 1, name: "A", projects: ["/a", "/b"] },
    },
  });
  expect(contextMenuItems([node("/a", true, true)])).not.toContainEqual(
    expect.objectContaining({ action: "project.detach" }),
  );
  expect(contextMenuItems([node("/b", true, true)])).toContainEqual(
    expect.objectContaining({ action: "project.detach" }),
  );
});
