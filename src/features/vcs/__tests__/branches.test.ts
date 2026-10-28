import { describe, expect, it } from "vitest";
import type { Branch } from "@/bindings";
import {
  branchFolderKeys,
  buildBranchRows,
  buildBranchTree,
  filterBranchTree,
  isFavoriteBranch,
  pushRecent,
  type BranchRow,
  type BranchTreeNode,
} from "../branches";
import { commitWebUrl, remoteWebUrl } from "../model";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: name.includes("/") && name.startsWith("origin/"),
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const branches = [
  b("feature/order-paging", { current: true, upstream: "origin/feature/order-paging", ahead: 2 }),
  b("zeta"),
  b("main"),
  b("bugfix"),
  b("origin/HEAD"),
  b("origin/main"),
  b("origin/feature/order-paging"),
];

const actions = [
  { id: "vcs.update", label: "Update Project…" },
  { id: "vcs.push", label: "Push…" },
];

const summary = (rows: BranchRow[]) =>
  rows.map((r) => {
    const indent = "depth" in r ? "  ".repeat(r.depth) : "";
    switch (r.type) {
      case "section":
        return r.label ? `# ${r.label}` : "---";
      case "action":
        return `> ${r.action.label}`;
      case "group":
        return `${indent}${r.expanded ? "v" : ">"} ${r.label}`;
      case "tag":
        return `${indent}tag:${r.tag}`;
      default:
        return `${indent}${r.group}:${r.label}${r.favorite ? " ★" : ""}`;
    }
  });

const open = (...keys: string[]) => new Map(keys.map((k) => [k, true]));

describe("buildBranchRows", () => {
  it("shows actions, then Recent open and Local / Remote collapsed", () => {
    expect(summary(buildBranchRows(branches, ["bugfix", "feature/order-paging", "gone"], "", actions))).toEqual([
      "> Update Project…",
      "> Push…",
      "---",
      "v Recent",
      "  recent:bugfix",
      "> Local",
      "> Remote",
    ]);
  });

  it("opens Local by default without recent branches", () => {
    expect(summary(buildBranchRows(branches, [], "", [], null, [], { groupByPrefix: false }))).toEqual([
      "v Local",
      "  local:feature/order-paging",
      "  local:main ★",
      "  local:bugfix",
      "  local:zeta",
      "> Remote",
    ]);
    expect(summary(buildBranchRows(branches, ["bugfix"], "", [], null, [], { showRecent: false })).slice(0, 1)).toEqual(
      ["v Local"],
    );
  });

  it("groups names by prefix: pinned first, then folders, then the rest; remotes are folders", () => {
    const rows = buildBranchRows(branches, ["bugfix"], "", [], null, [], {
      expanded: open("group:local", "group:remote"),
    });
    expect(summary(rows).slice(2)).toEqual([
      "v Local",
      "  local:main ★",
      // Holds the current branch: open.
      "  v feature",
      "    local:order-paging",
      "  local:bugfix",
      "  local:zeta",
      "v Remote",
      "  v origin",
      "    remote:main ★",
      "    > feature",
    ]);
    const closed = buildBranchRows(branches, ["bugfix"], "", [], null, [], {
      expanded: new Map([
        ["group:local", true],
        ["folder:local:feature", false],
      ]),
    });
    expect(summary(closed)).toContain("  > feature");
    expect(summary(closed)).not.toContain("    local:order-paging");
  });

  it("separates actions of different groups", () => {
    const grouped = [
      { id: "a", label: "Update Project…", group: "sync" },
      { id: "b", label: "Push…", group: "sync" },
      { id: "c", label: "New Branch…", group: "branch" },
    ];
    expect(summary(buildBranchRows([], [], "", grouped))).toEqual([
      "> Update Project…",
      "> Push…",
      "---",
      "> New Branch…",
    ]);
    expect(summary(buildBranchRows([], [], "u", grouped))).toEqual(["> Update Project…", "> Push…"]);
  });

  it("filters branches and actions by fuzzy query, opens every group and drops the Recent group", () => {
    const rows = buildBranchRows(branches, ["main"], "main", actions);
    expect(summary(rows)).toEqual(["v Local", "  local:main ★", "v Remote", "  v origin", "    remote:main ★"]);
    const local = rows[1]!;
    expect(local.type === "branch" && local.matches).toEqual([0, 1, 2, 3]);
    // Highlights shifted onto the shown part of `origin/main`.
    const remote = rows[4]!;
    expect(remote.type === "branch" && [remote.label, remote.matches]).toEqual(["main", [0, 1, 2, 3]]);
    expect(summary(buildBranchRows(branches, [], "push", actions))).toEqual(["> Push…"]);
  });

  it("omits empty groups", () => {
    expect(summary(buildBranchRows([b("main", { current: true })], [], "", []))).toEqual(["v Local", "  local:main ★"]);
  });

  it("puts the user's favorites right after the current branch", () => {
    const rows = buildBranchRows(branches, [], "", [], ["zeta", "origin/feature/order-paging"], [], {
      groupByPrefix: false,
      expanded: open("group:remote"),
    });
    expect(summary(rows)).toEqual([
      "v Local",
      "  local:feature/order-paging",
      "  local:zeta ★",
      "  local:bugfix",
      "  local:main",
      "v Remote",
      "  remote:origin/feature/order-paging ★",
      "  remote:origin/main",
    ]);
  });

  it("lists tags last in a collapsed group, newest version first, and filters them by the query", () => {
    const tags = ["v1.2", "v1.10", "release"];
    expect(summary(buildBranchRows([], [], "", [], null, tags))).toEqual(["> Tags"]);
    expect(summary(buildBranchRows([], [], "", [], null, tags, { expanded: open("group:tags") }))).toEqual([
      "v Tags",
      "  tag:v1.10",
      "  tag:v1.2",
      "  tag:release",
    ]);
    expect(summary(buildBranchRows(branches, [], "v1.1", [], null, tags))).toEqual(["v Tags", "  tag:v1.10"]);
    expect(summary(buildBranchRows([], [], "", [], null, tags, { showTags: false }))).toEqual([]);
  });
});

describe("pushRecent", () => {
  it("moves a branch to the front without duplicates", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});

describe("buildBranchTree", () => {
  const outline = (nodes: readonly BranchTreeNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [
      `${"  ".repeat(depth)}${n.favorite ? "*" : ""}${n.label}`,
      ...outline(n.children ?? [], depth + 1),
    ]);

  it("groups names into folders with favorites first", () => {
    const tree = buildBranchTree(
      [
        b("zeta"),
        b("feat/b"),
        b("feat/a"),
        b("main"),
        b("fix/deep/x"),
        b("dev", { current: true }),
        b("origin/main"),
        b("origin/feat/a"),
        b("origin/HEAD"),
      ],
      null,
    );
    expect(outline(tree)).toEqual([
      "HEAD (Current Branch)",
      "Local",
      "  dev",
      "  *main",
      "  feat",
      "    a",
      "    b",
      "  fix",
      "    deep",
      "      x",
      "  zeta",
      "Remote",
      "  origin",
      "    *main",
      "    feat",
      "      a",
    ]);
    expect(branchFolderKeys(tree, "fix/deep/x")).toEqual(["g:local", "f:local/fix", "f:local/fix/deep"]);
    expect(branchFolderKeys(tree, "nope")).toEqual([]);
  });

  it("filters by branch name, keeping the folders of matches", () => {
    const tree = buildBranchTree([b("main"), b("feat/login"), b("fix/login-crash"), b("origin/feat/login")], null);
    expect(outline(filterBranchTree(tree, "LOGIN"))).toEqual([
      "Local",
      "  feat",
      "    login",
      "  fix",
      "    login-crash",
      "Remote",
      "  origin",
      "    feat",
      "      login",
    ]);
    expect(filterBranchTree(tree, "nothing")).toEqual([]);
  });

  it("uses the stored favorites once the user edits them", () => {
    expect(isFavoriteBranch(b("main"), null)).toBe(true);
    expect(isFavoriteBranch(b("origin/master"), null)).toBe(true);
    expect(isFavoriteBranch(b("main"), ["dev"])).toBe(false);
    expect(isFavoriteBranch(b("dev"), ["dev"])).toBe(true);
  });
});

describe("remote web URLs", () => {
  it("maps ssh, scp-like and https remotes to their web page", () => {
    expect(remoteWebUrl("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(remoteWebUrl("ssh://git@gitlab.example.com:2222/group/sub/app.git")).toBe(
      "https://gitlab.example.com/group/sub/app",
    );
    expect(remoteWebUrl("https://user:token@github.com/o/r.git/")).toBe("https://github.com/o/r");
    expect(remoteWebUrl("/srv/git/app.git")).toBeNull();
    expect(commitWebUrl("git@github.com:o/r.git", "abc")).toBe("https://github.com/o/r/commit/abc");
    expect(commitWebUrl("git@bitbucket.org:o/r.git", "abc")).toBe("https://bitbucket.org/o/r/commits/abc");
  });
});
