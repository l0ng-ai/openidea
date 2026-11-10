import { afterEach, describe, expect, it } from "vitest";
import type { RecentProject } from "@/bindings";
import { useProject } from "@/platform/project";
import {
  createGroup,
  filterRecent,
  groupNameError,
  moveToGroup,
  recentRows,
  removeGroup,
  renameGroup,
  tildify,
  useRecent,
} from "./recent";
import { lastSessionProject, reopenEnabled, trackSession } from "./session";

const p = (name: string, path: string, branch: string | null = null): RecentProject => ({
  name,
  path,
  branch,
  openedAtMs: null,
});

const projects = [
  p("acme-api", "/Users/me/dev/acme", "main"),
  p("openidea-ide", "/Users/me/dev/openidea"),
  p("tokio", "/Users/me/oss/tokio"),
  p("notes", "/Volumes/data/acme-notes"),
];

describe("filterRecent", () => {
  it("returns everything in recency order for an empty query", () => {
    const all = filterRecent(projects, "  ", "/Users/me");
    expect(all.map((m) => m.project.name)).toEqual(["acme-api", "openidea-ide", "tokio", "notes"]);
    expect(all[0]!.displayPath).toBe("~/dev/acme");
    expect(all[3]!.displayPath).toBe("/Volumes/data/acme-notes");
  });

  it("puts name matches first, then path matches, with highlight indices", () => {
    const res = filterRecent(projects, "acme", "/Users/me");
    expect(res.map((m) => m.project.name)).toEqual(["acme-api", "notes"]);
    expect(res[0]!.nameMatch).toEqual([0, 1, 2, 3]);
    expect(res[1]!.nameMatch).toBeNull();
    expect(res[1]!.pathMatch).toEqual([14, 15, 16, 17]);
  });

  it("matches camel-hump / word starts and is case-insensitive", () => {
    expect(filterRecent(projects, "EIde").map((m) => m.project.name)).toEqual(["openidea-ide"]);
    expect(filterRecent(projects, "TOK").map((m) => m.project.name)).toEqual(["tokio"]);
    expect(filterRecent(projects, "zzz")).toEqual([]);
  });

  it("ignores scattered path subsequences", () => {
    expect(filterRecent([p("x", "/a/bcdefghijklmnopqrstuvwxyz/o/z")], "az")).toEqual([]);
  });
});

describe("helpers", () => {
  it("abbreviates the home directory", () => {
    expect(tildify("/Users/me/dev", "/Users/me")).toBe("~/dev");
    expect(tildify("/Users/meow", "/Users/me")).toBe("/Users/meow");
    expect(tildify("/x", null)).toBe("/x");
  });
});

describe("session restore", () => {
  afterEach(() => {
    useProject.setState({ project: null });
    localStorage.clear();
  });

  it("prefers the settings key over the local preference", () => {
    expect(reopenEnabled(null, true)).toBe(true);
    expect(reopenEnabled({}, false)).toBe(false);
    expect(reopenEnabled({ general: { reopenLastProject: false } } as never, true)).toBe(false);
    expect(reopenEnabled({ general: { reopenLastProject: true } } as never, false)).toBe(true);
  });

  it("remembers the open project and forgets it on explicit close", () => {
    const stop = trackSession();
    useProject.setState({ project: { root: "/w/a", name: "a", trusted: true, isGit: false, settings: {} } });
    expect(lastSessionProject()).toBe("/w/a");
    useProject.setState({ project: { root: "/w/b", name: "b", trusted: true, isGit: false, settings: {} } });
    expect(lastSessionProject()).toBe("/w/b");
    useProject.setState({ project: null });
    expect(lastSessionProject()).toBeNull();
    stop();
  });
});

describe("project groups", () => {
  const rows = (query = "") =>
    recentRows(projects, useRecent.getState().groups, query, "/Users/me").map((r) =>
      r.kind === "group" ? `[${r.group.name} ${r.count}]` : `${r.group ? "  " : ""}${r.m.project.name}`,
    );
  afterEach(() => useRecent.setState({ groups: [] }));

  it("lists groups first with their projects, then the rest; a search lists matches only", async () => {
    expect(rows()).toEqual(["acme-api", "openidea-ide", "tokio", "notes"]);
    await createGroup(" Work ", "/Users/me/dev/acme");
    await moveToGroup("/Users/me/dev/openidea", "Work");
    await createGroup("Oss", "/Users/me/oss/tokio");
    expect(rows()).toEqual(["[Work 2]", "  acme-api", "  openidea-ide", "[Oss 1]", "  tokio", "notes"]);
    expect(rows("tok")).toEqual(["tokio"]);

    useRecent.setState((s) => ({ groups: s.groups.map((g) => ({ ...g, expanded: g.name !== "Work" })) }));
    expect(rows()).toEqual(["[Work 2]", "[Oss 1]", "  tokio", "notes"]);
  });

  it("moves a project between groups, renames and removes groups without dropping projects", async () => {
    await createGroup("Work", "/Users/me/dev/acme");
    await createGroup("Oss");
    expect(groupNameError("work ")).toBeNull();
    expect(groupNameError(" Work")).toBe("A group named 'Work' already exists");
    expect(groupNameError("Work", "Work")).toBeNull();
    expect(groupNameError("  ")).toBe("Enter a group name");
    // A second group of the same name is not created.
    await createGroup("Work", "/Users/me/oss/tokio");
    expect(useRecent.getState().groups.map((g) => g.name)).toEqual(["Work", "Oss"]);

    await moveToGroup("/Users/me/dev/acme", "Oss");
    expect(rows()).toEqual(["[Work 0]", "[Oss 1]", "  acme-api", "openidea-ide", "tokio", "notes"]);
    await renameGroup("Oss", "Open source");
    await moveToGroup("/Users/me/oss/tokio", "Open source");
    await removeGroup("Work");
    expect(rows()).toEqual(["[Open source 2]", "  acme-api", "  tokio", "openidea-ide", "notes"]);
    await moveToGroup("/Users/me/dev/acme", null);
    await removeGroup("Open source");
    expect(rows()).toEqual(["acme-api", "openidea-ide", "tokio", "notes"]);
  });
});
