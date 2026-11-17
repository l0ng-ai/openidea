import { describe, expect, it } from "vitest";
import type { FileStatus } from "@/bindings";
import {
  aggregateCheck,
  buildChangeTree,
  checkOf,
  commitRepos,
  changeFileNodes,
  ignoreTargets,
  initialCheck,
  hunkIncluded,
  groupFileNodes,
  groupOf,
  planCommit,
  remainingOverrides,
  stagingSide,
  toggledHunk,
  type CheckState,
  type ChangeNode,
} from "../changes";
import { rootOf } from "../model";

const fs = (rel: string, staged: FileStatus["staged"], unstaged: FileStatus["unstaged"]): FileStatus => ({
  path: `/r/${rel}`,
  relPath: rel,
  staged,
  unstaged,
  renamedFrom: null,
});

const status = [
  fs("src/main/kotlin/App.kt", null, "modified"),
  fs("src/main/kotlin/Partial.kt", "modified", "modified"),
  fs("src/test/AppTest.kt", "added", null),
  fs("README.md", "modified", null),
  fs("notes.txt", null, "untracked"),
  fs("conf.yml", null, "conflicted"),
  fs("out/", null, "ignored"),
];

const shape = (nodes: ChangeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label}`, ...shape(n.children ?? [], depth + 1)]);

describe("buildChangeTree by staging state", () => {
  const tree = buildChangeTree(status, "/r", false, undefined, [], true);
  const names = (g: string) => (tree.find((n) => n.group === g)?.children ?? []).map((n) => n.label);

  it("splits Changes into Staged and Unstaged, keeping the other groups", () => {
    expect(tree.map((n) => n.label)).toEqual([
      "Merge Conflicts",
      "Staged Changes",
      "Unstaged Changes",
      "Unversioned Files",
    ]);
  });

  it("lists a partially staged file under both groups", () => {
    expect(names("staged")).toEqual(["AppTest.kt", "Partial.kt", "README.md"]);
    expect(names("unstaged")).toEqual(["App.kt", "Partial.kt"]);
  });

  it("compares a partially staged file on the side of its group only", () => {
    const partial = status[1]!;
    expect(stagingSide("staged", partial)).toBe("staged");
    expect(stagingSide("unstaged", partial)).toBe("unstaged");
    expect(stagingSide("staged", status[3]!)).toBeNull();
    expect(stagingSide("changes", partial)).toBeNull();
  });

  it("chains the diff through the files of the clicked group", () => {
    const node = tree.find((n) => n.group === "unstaged")!.children![1]!;
    expect(groupFileNodes(tree, node).map((n) => n.key)).toEqual([
      "unstaged:/r/src/main/kotlin/App.kt",
      "unstaged:/r/src/main/kotlin/Partial.kt",
    ]);
  });

  it("is off by default", () => {
    expect(buildChangeTree(status, "/r", false).some((n) => n.group === "staged")).toBe(false);
  });
});

describe("buildChangeTree", () => {
  it("groups conflicts, changes and unversioned files (flat)", () => {
    expect(shape(buildChangeTree(status, "/r", false))).toEqual([
      "Merge Conflicts",
      "  conf.yml",
      "Changes",
      "  App.kt",
      "  AppTest.kt",
      "  Partial.kt",
      "  README.md",
      "Unversioned Files",
      "  notes.txt",
    ]);
  });

  it("groups by directory with compacted chains", () => {
    const changes = buildChangeTree(status, "/r", true).find((n) => n.group === "changes")!;
    expect(shape([changes])).toEqual([
      "Changes",
      "  src",
      "    main/kotlin",
      "      App.kt",
      "      Partial.kt",
      "    test",
      "      AppTest.kt",
      "  README.md",
    ]);
    expect(changes.children![0]!.files).toHaveLength(3);
  });
});

describe("unversioned file grouping", () => {
  it.each([true, false])(
    "keeps staged additions deleted from disk visible with separate unversioned grouping %s",
    (separate) => {
      const added = fs("added.txt", "added", "deleted");
      const untracked = fs("new.txt", null, "untracked");
      const tree = buildChangeTree([added, untracked], "/r", false, undefined, [], true, {}, true, separate);
      expect(tree.find((n) => n.group === "staged")?.files).toEqual([added]);
      expect(tree.find((n) => n.group === "unstaged")?.files).toEqual(separate ? [added] : [added, untracked]);
      expect(tree.find((n) => n.group === "unversioned")?.files).toEqual(separate ? [untracked] : undefined);
      const changes = buildChangeTree([added, untracked], "/r", false, undefined, [], false, {}, true, separate);
      expect(changeFileNodes(changes).some((n) => n.path === added.path)).toBe(false);
      expect(groupOf(untracked)).toBe("unversioned");
    },
  );

  it.each([false, true])("can merge untracked files independently of staging grouping (%s)", (byStaging) => {
    const tree = buildChangeTree(status, "/r", false, undefined, [], byStaging, {}, true, false);
    expect(tree.some((n) => n.group === "unversioned")).toBe(false);
    expect(tree.find((n) => n.group === "conflicts")?.files).toEqual([status[5]]);
    const merged = tree.find((n) => n.group === (byStaging ? "unstaged" : "changes"))!;
    const untracked = merged.children!.find((n) => n.path === status[4]!.path)!;
    expect(untracked.kind).toBe("untracked");
    expect(groupOf(untracked.files[0]!)).toBe("unversioned");
    expect(checkOf(untracked.files[0]!, new Map())).toBe("none");
    expect(ignoreTargets([merged], [])).toEqual([status[4]!.path]);
    expect(planCommit(status, new Map()).included).not.toContain(status[4]);
    if (byStaging) expect(tree.find((n) => n.group === "staged")!.files).not.toContain(status[4]);
  });

  it.each([false, true])("shows a repository containing only untracked files (%s)", (byStaging) => {
    const tree = buildChangeTree([status[4]!], "/r", true, undefined, [], byStaging, {}, true, false);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.group).toBe(byStaging ? "unstaged" : "changes");
    expect(tree[0]!.files).toEqual([status[4]]);
  });

  it("merges into the same directory and repository as tracked changes", () => {
    const tracked = fs("libs/core/src/App.kt", null, "modified");
    const untracked = fs("libs/core/src/New.kt", null, "untracked");
    const tree = buildChangeTree(
      [status[0]!, tracked, untracked],
      "/r",
      true,
      undefined,
      ["/r", "/r/libs/core"],
      true,
      {},
      true,
      false,
    );
    const repo = tree[0]!.children!.find((n) => n.path === "/r/libs/core")!;
    expect(repo.files).toEqual([tracked, untracked]);
    expect(shape(repo.children!)).toEqual(["src", "  App.kt", "  New.kt"]);
    expect(ignoreTargets([repo], ["/r", "/r/libs/core"])).toEqual([untracked.path]);
  });

  it("displays untracked files in the active changelist without assigning them to it", () => {
    const lists = {
      active: "feature",
      lists: [
        { id: "default", name: "Changes", comment: "" },
        { id: "feature", name: "Feature", comment: "" },
      ],
      files: { "notes.txt": "default" },
    };
    const tree = buildChangeTree([status[4]!], "/r", false, lists, [], false, {}, true, false);
    expect(tree.find((n) => n.changelist === "default")!.files).toEqual([]);
    expect(tree.find((n) => n.changelist === "feature")!.files).toEqual([status[4]]);
    expect(lists.files).toEqual({ "notes.txt": "default" });
    expect(initialCheck(status[4]!)).toBe("none");
  });
});

describe("several repositories", () => {
  const nested = [...status, fs("libs/core/Lib.kt", null, "modified"), fs("libs/core/new.txt", null, "untracked")];
  const repos = ["/r", "/r/libs/core"];

  it("groups each change group by repository", () => {
    expect(shape(buildChangeTree(nested, "/r", false, undefined, repos))).toEqual([
      "Merge Conflicts",
      "  r",
      "    conf.yml",
      "Changes",
      "  r",
      "    App.kt",
      "    AppTest.kt",
      "    Partial.kt",
      "    README.md",
      "  libs/core",
      "    Lib.kt",
      "Unversioned Files",
      "  r",
      "    notes.txt",
      "  libs/core",
      "    new.txt",
    ]);
    const changes = buildChangeTree(nested, "/r", true, undefined, repos)[1]!;
    expect(changes.children!.map((n) => [n.label, n.path])).toEqual([
      ["r", "/r"],
      ["libs/core", "/r/libs/core"],
    ]);
    expect(shape(changes.children![1]!.children!)).toEqual(["Lib.kt"]);
    // One repository: no repository level.
    const single = buildChangeTree(status, "/r", false, undefined, ["/r"]);
    expect(shape(single)).toEqual(shape(buildChangeTree(status, "/r", false)));
  });

  it("commits every repository with included changes, the selected one last", () => {
    const included = [nested[0]!, nested[7]!];
    expect(commitRepos(included, repos, "/r")).toEqual(["/r/libs/core", "/r"]);
    expect(commitRepos(included.slice(0, 1), repos, "/r/libs/core")).toEqual(["/r"]);
    expect(commitRepos([], repos, "/r/libs/core")).toEqual(["/r/libs/core"]);
  });

  it("shows each repository's branch, or its HEAD commit when detached, beside its name", () => {
    const repoDetails = (tree: ChangeNode[]) =>
      tree.map((g) => [g.label, ...(g.children ?? []).map((n) => `${n.label} ${n.detail ?? "-"}`)]);
    const heads = {
      "/r": { head: "feature/ABC-123", headCommit: "0123456789abcdef0123456789abcdef01234567" },
      "/r/libs/core": { head: null, headCommit: "89abcdef0123456789abcdef0123456789abcdef" },
    };
    expect(repoDetails(buildChangeTree(nested, "/r", false, undefined, repos, false, heads))).toEqual([
      ["Merge Conflicts", "r feature/ABC-123"],
      ["Changes", "r feature/ABC-123", "libs/core 89abcdef"],
      ["Unversioned Files", "r feature/ABC-123", "libs/core 89abcdef"],
    ]);
    const staging = buildChangeTree(nested, "/r", false, undefined, repos, true, heads);
    expect(repoDetails(staging)[2]).toEqual(["Unstaged Changes", "r feature/ABC-123", "libs/core 89abcdef"]);
    const lists = { lists: [{ id: "d", name: "Changes", comment: "" }], active: "d", files: {} } as never;
    expect(repoDetails(buildChangeTree(nested, "/r", false, lists, repos, false, heads))[1]).toEqual([
      "Changes",
      "r feature/ABC-123",
      "libs/core 89abcdef",
    ]);
    // Not loaded yet, or HEAD unreadable: no hint.
    const partial = { "/r/libs/core": { head: null, headCommit: null } };
    expect(repoDetails(buildChangeTree(nested, "/r", false, undefined, repos, false, partial))[1]).toEqual([
      "Changes",
      "r -",
      "libs/core -",
    ]);
    // A repository without commits is on its unborn branch.
    const unborn = { "/r/libs/core": { head: "main", headCommit: null } };
    expect(repoDetails(buildChangeTree(nested, "/r", false, undefined, repos, false, unborn))[1]).toEqual([
      "Changes",
      "r -",
      "libs/core main",
    ]);
    expect(repoDetails(buildChangeTree(nested, "/r", false, undefined, repos))[1]).toEqual([
      "Changes",
      "r -",
      "libs/core -",
    ]);
    // One repository: no repository level, files keep their own details.
    const single = buildChangeTree(status, "/r", false, undefined, ["/r"], false, { "/r": heads["/r"] });
    expect(single).toEqual(buildChangeTree(status, "/r", false));
  });

  it("marks the hint with a branch icon, or a commit icon when detached, on repository nodes only", () => {
    const heads = {
      "/r": { head: "main", headCommit: "0123456789" },
      "/r/libs/core": { head: null, headCommit: "89abcdef01" },
    };
    const icons = (nodes: ChangeNode[]): string[] =>
      nodes.flatMap((n) => [`${n.label}:${n.detailIcon ?? "-"}`, ...icons(n.children ?? [])]);
    const changes = buildChangeTree(nested, "/r", true, undefined, repos, false, heads)[1]!;
    expect(icons([changes])).toEqual([
      "Changes:-",
      "r:branch",
      "src:-",
      "main/kotlin:-",
      "App.kt:-",
      "Partial.kt:-",
      "test:-",
      "AppTest.kt:-",
      "README.md:-",
      "libs/core:commit",
      "Lib.kt:-",
    ]);
    const unloaded = buildChangeTree(nested, "/r", true, undefined, repos)[1]!;
    expect(unloaded.children!.map((n) => n.detailIcon)).toEqual([undefined, undefined]);
  });

  it("routes a nested repository's own entry (submodule) to the enclosing repository", () => {
    expect(rootOf("/r/libs/core/Lib.kt", repos)).toBe("/r/libs/core");
    expect(rootOf("/r/libs/core", repos)).toBe("/r");
    expect(rootOf("/r/libs/core/", repos)).toBe("/r");
    expect(rootOf("/r", repos)).toBe("/r");
    expect(rootOf("/other", repos)).toBeNull();
  });
});

describe("Group By › Repository off", () => {
  const at = (path: string, unstaged: FileStatus["unstaged"] = "modified", staged: FileStatus["staged"] = null) => ({
    path,
    relPath: path.split("/").slice(3).join("/"),
    staged,
    unstaged,
    renamedFrom: null,
  });
  // Two repositories holding the same repository-relative path.
  const repos = ["/w/api", "/w/sdk"];
  const twins = [at("/w/api/src/config.ts"), at("/w/sdk/src/config.ts"), at("/w/sdk/src/client.ts")];
  const keys = (nodes: readonly ChangeNode[]): string[] => nodes.flatMap((n) => [n.key, ...keys(n.children ?? [])]);
  const files = (nodes: readonly ChangeNode[]) =>
    changeFileNodes(nodes).map((n) => `${n.label} ${n.path} ${n.detail || "-"}`);

  it("lists the files of all repositories together, told apart by their directory", () => {
    const tree = buildChangeTree(twins, "/w", false, undefined, repos, false, {}, false);
    expect(shape(tree)).toEqual(["Changes", "  client.ts", "  config.ts", "  config.ts"]);
    expect(files(tree)).toEqual([
      "client.ts /w/sdk/src/client.ts sdk/src",
      "config.ts /w/api/src/config.ts api/src",
      "config.ts /w/sdk/src/config.ts sdk/src",
    ]);
    const all = keys(tree);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps directory grouping, with each repository's directories apart", () => {
    const tree = buildChangeTree(twins, "/w", true, undefined, repos, false, {}, false);
    expect(shape(tree)).toEqual([
      "Changes",
      "  api/src",
      "    config.ts",
      "  sdk/src",
      "    client.ts",
      "    config.ts",
    ]);
    expect(tree[0]!.children!.map((n) => [n.path, n.files.length])).toEqual([
      ["/w/api/src", 1],
      ["/w/sdk/src", 2],
    ]);
    const all = keys(tree);
    expect(new Set(all).size).toBe(all.length);
  });

  it("shows a repository outside the project by its absolute directory", () => {
    const outside = [at("/w/README.md"), at("/x/lib/src/Lib.kt")];
    const flat = buildChangeTree(outside, "/w", false, undefined, ["/w", "/x/lib"], false, {}, false);
    expect(files(flat)).toEqual(["Lib.kt /x/lib/src/Lib.kt /x/lib/src", "README.md /w/README.md -"]);
    const dirs = buildChangeTree(outside, "/w", true, undefined, ["/w", "/x/lib"], false, {}, false);
    expect(shape(dirs)).toEqual(["Changes", "  /x/lib/src", "    Lib.kt", "  README.md"]);
    expect(dirs[0]!.children![0]!.path).toBe("/x/lib/src");
  });

  it("applies to every group, staging groups and change lists included", () => {
    const mixed = [...twins, at("/w/api/new.txt", "untracked"), at("/w/sdk/src/both.ts", "modified", "modified")];
    const noRepoNodes = (tree: ChangeNode[]) =>
      tree.every((g) => g.children!.every((n) => n.type === "file" && !repos.includes(n.path!)));
    expect(noRepoNodes(buildChangeTree(mixed, "/w", false, undefined, repos, false, {}, false))).toBe(true);
    expect(noRepoNodes(buildChangeTree(mixed, "/w", false, undefined, repos, true, {}, false))).toBe(true);
    const lists = { active: "default", lists: [{ id: "default", name: "Changes", comment: "" }], files: {} };
    const listed = buildChangeTree(mixed, "/w", false, lists as never, repos, false, {}, false);
    expect(noRepoNodes(listed)).toBe(true);
    expect(changeFileNodes(listed).every((n) => n.changelist === "default" || n.group === "unversioned")).toBe(true);
  });

  it("checks and commits files of every repository from the one flat group", () => {
    const [changes] = buildChangeTree(twins, "/w", false, undefined, repos, false, {}, false);
    expect(aggregateCheck(changes!.files, new Map())).toMatchObject({ checked: true, on: 3 });
    const checks = new Map<string, CheckState>([["/w/api/src/config.ts", "none"]]);
    expect(aggregateCheck(changes!.files, checks)).toMatchObject({ checked: false, indeterminate: true, on: 2 });
    const plan = planCommit(twins, checks);
    expect(plan.included.map((f) => f.path)).toEqual(["/w/sdk/src/config.ts", "/w/sdk/src/client.ts"]);
    expect(commitRepos(planCommit(twins, new Map()).included, repos, "/w/api")).toEqual(["/w/sdk", "/w/api"]);
  });

  it("is on by default: a repository level as before", () => {
    expect(buildChangeTree(twins, "/w", true, undefined, repos, false, {})).toEqual(
      buildChangeTree(twins, "/w", true, undefined, repos, false, {}, true),
    );
    expect(shape(buildChangeTree(twins, "/w", false, undefined, repos))).toEqual([
      "Changes",
      "  api",
      "    config.ts",
      "  sdk",
      "    client.ts",
      "    config.ts",
    ]);
  });
});

describe("ignore targets", () => {
  const group = (roots: ChangeNode[], id: string) => roots.find((n) => n.group === id)!;

  it("takes unversioned files only, not tracked changes", () => {
    const tree = buildChangeTree(status, "/r", true);
    expect(ignoreTargets([group(tree, "changes")], [])).toEqual([]);
    expect(ignoreTargets([group(tree, "unversioned")], [])).toEqual(["/r/notes.txt"]);
  });

  it("uses one rule for a directory whose files are all unversioned", () => {
    const tree = buildChangeTree(
      [
        fs("build/out.log", null, "untracked"),
        fs("build/tmp/a.tmp", null, "untracked"),
        fs("notes.txt", null, "untracked"),
      ],
      "/r",
      true,
    );
    expect(ignoreTargets([group(tree, "unversioned")], [])).toEqual(["/r/build", "/r/notes.txt"]);
  });

  it("lists the files of every repository instead of a repository root", () => {
    const nested = [...status, fs("libs/core/new.txt", null, "untracked")];
    const repos = ["/r", "/r/libs/core"];
    const tree = buildChangeTree(nested, "/r", false, undefined, repos);
    expect(ignoreTargets([group(tree, "unversioned")], repos)).toEqual(["/r/notes.txt", "/r/libs/core/new.txt"]);
  });
});

describe("commit inclusion", () => {
  it("defaults: tracked changes included, partial files keep their staged part, unversioned excluded", () => {
    expect(initialCheck(status[0]!)).toBe("all");
    expect(initialCheck(status[1]!)).toBe("staged");
    expect(initialCheck(status[4]!)).toBe("none");
    expect(initialCheck(status[5]!)).toBe("none");
  });

  it("plans which changes the commit takes and which staged ones it leaves out", () => {
    const checks = new Map<string, CheckState>([
      ["/r/README.md", "none"],
      ["/r/notes.txt", "all"],
    ]);
    const plan = planCommit(status, checks);
    expect(plan.stage.sort()).toEqual(["/r/notes.txt", "/r/src/main/kotlin/App.kt"]);
    expect(plan.exclude).toEqual(["/r/README.md"]);
    expect(plan.included.map((f) => f.relPath).sort()).toEqual([
      "notes.txt",
      "src/main/kotlin/App.kt",
      "src/main/kotlin/Partial.kt",
      "src/test/AppTest.kt",
    ]);
  });

  it("leaves out a file added to the index and then deleted, which no group lists", () => {
    const files = [fs("src/A.java", null, "modified"), fs("src/Gone.java", "added", "deleted")];
    expect(
      buildChangeTree(files, "/r", false)
        .flatMap((g) => g.children ?? [])
        .map((n) => n.label),
    ).toEqual(["A.java"]);
    const plan = planCommit(files, new Map());
    expect(plan.stage).toEqual(["/r/src/A.java"]);
    expect(plan.exclude).toEqual(["/r/src/Gone.java"]);
    expect(plan.included.map((f) => f.relPath)).toEqual(["src/A.java"]);
  });

  it("aggregates checkbox state for groups", () => {
    const checks = new Map<string, CheckState>();
    expect(aggregateCheck([status[0]!, status[3]!], checks)).toMatchObject({ checked: true, indeterminate: false });
    expect(aggregateCheck([status[0]!, status[4]!], checks)).toMatchObject({ checked: false, indeterminate: true });
    expect(aggregateCheck([status[1]!], checks)).toMatchObject({ checked: false, indeterminate: true });
  });

  it("keeps the changes left out of a commit excluded after it", () => {
    const files = Array.from({ length: 20 }, (_, i) => fs(`src/f${i}.kt`, null, "modified"));
    const leftOut = files.slice(5);
    const checks = new Map<string, CheckState>(leftOut.map((f) => [f.path, "none"]));
    const plan = planCommit(files, checks);
    expect(plan.included).toHaveLength(5);

    // The commit takes its 5 files out of the tree; the 15 left out keep their override.
    const kept = remainingOverrides(checks, plan.included);
    expect(kept.has(files[0]!.path)).toBe(false);
    expect(leftOut.every((f) => checkOf(f, kept) === "none")).toBe(true);
    expect(aggregateCheck(leftOut, kept)).toMatchObject({ checked: false, indeterminate: false });
  });

  it("drops only the committed paths from the per-file overrides", () => {
    const overrides = new Map([
      ["/r/a.ts", new Set(["h1"])],
      ["/r/b.ts/", new Set(["h2"])],
    ]);
    expect([...remainingOverrides(overrides, [fs("a.ts", null, "modified")])]).toEqual([["/r/b.ts/", new Set(["h2"])]]);
  });

  it("commits a file with excluded blocks partially, without staging it", () => {
    const checks = new Map<string, CheckState>([["/r/src/main/kotlin/App.kt", "hunks"]]);
    const plan = planCommit(status, checks);
    expect(plan.partial).toEqual(["/r/src/main/kotlin/App.kt"]);
    expect(plan.stage).not.toContain("/r/src/main/kotlin/App.kt");
    expect(plan.included.map((f) => f.relPath)).toContain("src/main/kotlin/App.kt");
    expect(aggregateCheck([status[0]!], checks)).toMatchObject({ checked: false, indeterminate: true });
  });

  it("toggles single blocks: tri-state file, all in → all, all out → none", () => {
    const all = ["a", "b", "c"];
    const one = toggledHunk("all", undefined, all, "b");
    expect(one).toEqual({ check: "hunks", excluded: new Set(["b"]) });
    expect(hunkIncluded(one.check, one.excluded, "a")).toBe(true);
    expect(hunkIncluded(one.check, one.excluded, "b")).toBe(false);
    expect(toggledHunk(one.check, one.excluded, all, "b")).toEqual({ check: "all", excluded: new Set() });
    // From an unchecked file, ticking one block includes just that block.
    const picked = toggledHunk("none", undefined, all, "c");
    expect(picked).toEqual({ check: "hunks", excluded: new Set(["a", "b"]) });
    expect(toggledHunk("hunks", new Set(["a", "b"]), all, "c").check).toBe("none");
    // Keys of blocks that no longer exist are dropped.
    expect(toggledHunk("hunks", new Set(["gone", "a"]), all, "b").excluded).toEqual(new Set(["a", "b"]));
  });
});

describe("changeFileNodes", () => {
  const file: ChangeNode = {
    key: "/p/src/a.ts",
    type: "file",
    label: "a.ts",
    group: "changes",
    path: "/p/src/a.ts",
    files: [],
  };
  const tree: ChangeNode[] = [
    { key: "group:changes", type: "group", label: "Changes", group: "changes", children: [file], files: [] },
  ];

  it("lists the file nodes through nested groups, in tree order", () => {
    expect(changeFileNodes(tree)).toEqual([file]);
  });

  it("lists a partially staged file under both staging groups", () => {
    const fs = {
      path: "/p/a.ts",
      relPath: "a.ts",
      staged: "modified",
      unstaged: "modified",
      renamedFrom: null,
    } as const;
    const nodes = changeFileNodes(buildChangeTree([fs], "/p", false, undefined, ["/p"], true));
    expect(nodes.map((n) => n.group)).toEqual(["staged", "unstaged"]);
  });
});
