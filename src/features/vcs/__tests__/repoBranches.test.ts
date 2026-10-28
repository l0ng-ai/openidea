import { describe, expect, it } from "vitest";
import type { Branch } from "@/bindings";
import { useI18n } from "@/platform/i18n";
import {
  buildMultiRepoRows,
  commonBranches,
  currentRepoFor,
  repoColorIndex,
  repoHeadLabel,
  widgetShowsRepo,
  type RepoEntry,
  type RepoRow,
} from "../repoBranches";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: name.startsWith("origin/") || name.startsWith("upstream/"),
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const repo = (name: string, head: string | null = "dev"): RepoEntry => ({
  root: `/p/${name}`,
  name,
  head,
  headCommit: "0123456789abcdef",
});

// The reported layout: several repositories, all on `dev`.
const repos = [repo("ology-collect"), repo("ology-dependencies"), repo("ology-gateway")];
const branches: Record<string, Branch[]> = {
  "/p/ology-collect": [
    b("dev", { current: true }),
    b("main"),
    b("collect-only"),
    b("origin/HEAD"),
    b("origin/dev"),
    b("origin/main"),
    b("origin/feature/x"),
  ],
  "/p/ology-dependencies": [b("dev", { current: true }), b("main"), b("origin/dev"), b("origin/main")],
  "/p/ology-gateway": [b("dev", { current: true }), b("main"), b("origin/dev"), b("origin/main"), b("gw-fix")],
};
const actions = [
  { id: "vcs.update", label: "Update Project…" },
  { id: "vcs.newBranch", label: "New Branch…" },
];

const summary = (rows: RepoRow[]) =>
  rows.map((r) => {
    switch (r.type) {
      case "section":
        return r.label ? `# ${r.label}` : "---";
      case "action":
        return `> ${r.action.label}`;
      case "repo":
        return `repo ${r.repo.name} [${r.repo.head}] c${r.color}`;
      case "group":
        return `${"  ".repeat(r.depth)}${r.expanded ? "v" : ">"} ${r.label}`;
      case "common":
        return `${"  ".repeat(r.depth)}${r.label}${r.branch.current ? " (current)" : ""}`;
      case "branch":
        return `${"  ".repeat(r.depth)}${r.repo.name}:${r.branch.name}`;
      case "tag":
        return `${"  ".repeat(r.depth)}tag ${r.tag}`;
    }
  });

describe("currentRepoFor (shared by the widget and the popup)", () => {
  const roots = ["/p", "/p/ology-collect", "/p/ology-collect/sub", "/p/ology-gateway"];
  it.each([
    [
      "the innermost repository of the active file",
      "/p/ology-collect/src/A.java",
      "/p/ology-gateway",
      "/p/ology-collect",
    ],
    ["a nested repository's file", "/p/ology-collect/sub/x.ts", null, "/p/ology-collect/sub"],
    ["the project's own repository", "/p/README.md", "/p/ology-gateway", "/p"],
    ["no active file: the selected repository", null, "/p/ology-gateway", "/p/ology-gateway"],
    ["a file outside every repository: the selected one", "/elsewhere/a.txt", "/p/ology-gateway", "/p/ology-gateway"],
    ["a selected repository that is gone: the first", null, "/gone", "/p"],
    ["nothing selected: the first", null, null, "/p"],
  ])("%s", (_name, active, selected, expected) => {
    expect(currentRepoFor(active, roots, selected)).toBe(expected);
  });

  it("is null without repositories", () => {
    expect(currentRepoFor("/p/a", [], null)).toBeNull();
  });
});

describe("widgetShowsRepo", () => {
  it.each([
    ["one repository", [{ head: "main" }], false],
    ["all on the same branch", [{ head: "dev" }, { head: "dev" }, { head: "dev" }], false],
    ["one on another branch", [{ head: "dev" }, { head: "feature" }, { head: "dev" }], true],
    ["one detached", [{ head: "dev" }, { head: null }], true],
    ["all detached", [{ head: null }, { head: null }], true],
    ["no repositories", [], false],
  ])("%s", (_name, heads, shows) => {
    expect(widgetShowsRepo(heads)).toBe(shows);
  });
});

describe("commonBranches", () => {
  it("keeps the branches every repository has, current in all first, then favourites", () => {
    const common = commonBranches(Object.values(branches));
    expect(common.local.map((x) => [x.name, x.current, x.favorite])).toEqual([
      ["dev", true, false],
      ["main", false, true],
    ]);
    expect(common.remote.map((x) => x.name)).toEqual(["origin/main", "origin/dev"]);
  });

  it("is current only when checked out everywhere", () => {
    const common = commonBranches([[b("dev", { current: true })], [b("dev")]]);
    expect(common.local).toEqual([{ name: "dev", remote: false, current: false, favorite: false }]);
  });

  it("does not match a local branch with a remote one of the same name", () => {
    expect(commonBranches([[b("origin/x", { remote: false })], [b("origin/x")]])).toEqual({ local: [], remote: [] });
    expect(commonBranches([])).toEqual({ local: [], remote: [] });
  });
});

describe("buildMultiRepoRows", () => {
  const input = { repos, branches, actions, expanded: new Map<string, boolean>() };

  it("lists actions, repositories with their branch, then the common groups", () => {
    expect(summary(buildMultiRepoRows({ ...input, query: "" }))).toEqual([
      "> Update Project…",
      "> New Branch…",
      "---",
      "repo ology-collect [dev] c1",
      "repo ology-dependencies [dev] c2",
      "repo ology-gateway [dev] c3",
      "---",
      "v Common Local Branches",
      "  dev (current)",
      "  main",
      "> Common Remote Branches",
    ]);
  });

  it("groups common remote branches by remote when expanded", () => {
    const expanded = new Map([
      ["common:local", false],
      ["common:remote", true],
    ]);
    expect(summary(buildMultiRepoRows({ ...input, expanded, query: "" })).slice(-6)).toEqual([
      "---",
      "> Common Local Branches",
      "v Common Remote Branches",
      "  v origin",
      "    main",
      "    dev",
    ]);
  });

  it("filters repositories and branches, expands every group and lists each repository's own matches", () => {
    expect(summary(buildMultiRepoRows({ ...input, expanded: new Map(), query: "dev" }))).toEqual([
      "v Common Local Branches",
      "  dev (current)",
      "v Common Remote Branches",
      "  v origin",
      "    dev",
    ]);
    expect(summary(buildMultiRepoRows({ ...input, query: "deps" }))).toEqual(["repo ology-dependencies [dev] c2"]);
    expect(summary(buildMultiRepoRows({ ...input, query: "fix" }))).toEqual([
      "# ology-gateway",
      "ology-gateway:gw-fix",
    ]);
    expect(summary(buildMultiRepoRows({ ...input, query: "collect" }))).toEqual([
      "repo ology-collect [dev] c1",
      "# ology-collect",
      "ology-collect:collect-only",
    ]);
  });

  it("highlights the shown part of a remote branch name", () => {
    const rows = buildMultiRepoRows({ ...input, query: "origin/dev" });
    const dev = rows.find((r) => r.type === "common" && r.branch.name === "origin/dev");
    expect(dev?.type === "common" && [dev.label, dev.matches]).toEqual(["dev", [0, 1, 2]]);
  });

  it("shows no common branches until every repository's branches are loaded", () => {
    const partial = { "/p/ology-collect": branches["/p/ology-collect"]! };
    expect(summary(buildMultiRepoRows({ ...input, branches: partial, query: "" })).at(-1)).toBe(
      "repo ology-gateway [dev] c3",
    );
  });

  it("matches and shows actions and groups in the UI language", () => {
    const texts = { "Update Project…": "更新项目…", "Common Local Branches": "公共本地分支" };
    useI18n.setState({ texts });
    try {
      const rows = buildMultiRepoRows({ ...input, query: "更新" });
      expect(rows.map((r) => (r.type === "action" ? r.matches : null))).toEqual([[0, 1]]);
      expect(summary(buildMultiRepoRows({ ...input, query: "" }))).toContain("v 公共本地分支");
    } finally {
      useI18n.setState({ texts: {} });
    }
  });
});

describe("buildMultiRepoRows with repositories on different branches", () => {
  const diverged = [repo("ology-collect", "release/1.0"), repo("ology-dependencies"), repo("ology-gateway")];
  const own: Record<string, Branch[]> = {
    ...branches,
    "/p/ology-collect": [
      b("release/1.0", { current: true }),
      b("dev"),
      b("main"),
      b("origin/dev"),
      b("origin/release/1.0"),
    ],
  };
  const input = {
    repos: diverged,
    branches: own,
    actions: [],
    expanded: new Map<string, boolean>(),
    recent: ["dev", "release/1.0", "gone"],
    tags: ["v1.2", "v1.10"],
  };

  it("lists the current repository's recent, local, remote branches and tags instead of the common ones", () => {
    expect(summary(buildMultiRepoRows({ ...input, current: "/p/ology-collect", query: "" }))).toEqual([
      "repo ology-collect [release/1.0] c1",
      "repo ology-dependencies [dev] c2",
      "repo ology-gateway [dev] c3",
      "---",
      "v Recent Branches in ology-collect",
      "  ology-collect:dev",
      "> Local Branches in ology-collect",
      "> Remote Branches in ology-collect",
      "> Tags in ology-collect",
    ]);
  });

  it("groups the current repository's branches by prefix, opening the current branch's folder", () => {
    const expanded = new Map([["repo:local", true]]);
    const rows = summary(buildMultiRepoRows({ ...input, expanded, current: "/p/ology-collect", query: "" }));
    expect(rows.slice(6, 11)).toEqual([
      "v Local Branches in ology-collect",
      "  ology-collect:main",
      "  v release",
      "    ology-collect:release/1.0",
      "  ology-collect:dev",
    ]);
    const flat = summary(
      buildMultiRepoRows({
        ...input,
        expanded,
        groupByPrefix: false,
        showRecent: false,
        current: "/p/ology-collect",
        query: "",
      }),
    );
    expect(flat.slice(4, 8)).toEqual([
      "v Local Branches in ology-collect",
      "  ology-collect:release/1.0",
      "  ology-collect:main",
      "  ology-collect:dev",
    ]);
  });

  it("falls back to the first repository and expands the matching lists on search", () => {
    const expanded = new Map([
      ["repo:tags", true],
      ["repo:recent", true],
    ]);
    const rows = summary(buildMultiRepoRows({ ...input, expanded, current: "/elsewhere", query: "" }));
    expect(rows.slice(4)).toEqual([
      "v Recent Branches in ology-collect",
      "  ology-collect:dev",
      "> Local Branches in ology-collect",
      "> Remote Branches in ology-collect",
      "v Tags in ology-collect",
      "  tag v1.10",
      "  tag v1.2",
    ]);
    // Search: the current repository's lists, then the other repositories' branches.
    expect(summary(buildMultiRepoRows({ ...input, current: "/p/ology-gateway", query: "fix" }))).toEqual([
      "v Local Branches in ology-gateway",
      "  ology-gateway:gw-fix",
    ]);
    expect(summary(buildMultiRepoRows({ ...input, current: "/p/ology-gateway", query: "rel" }))).toEqual([
      "# ology-collect",
      "ology-collect:release/1.0",
      "ology-collect:origin/release/1.0",
    ]);
  });
});

describe("repository colours and heads", () => {
  it("gives up to nine repositories distinct colours, then cycles", () => {
    expect(Array.from({ length: 10 }, (_, i) => repoColorIndex(i))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 1]);
  });

  it("names a detached HEAD by its short commit", () => {
    expect(repoHeadLabel({ head: "dev", headCommit: "0123456789" })).toBe("dev");
    expect(repoHeadLabel({ head: null, headCommit: "0123456789" })).toBe("01234567");
    expect(repoHeadLabel({ head: null, headCommit: null })).toBe("No commits");
  });
});
