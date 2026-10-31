import { afterEach, describe, expect, it } from "vitest";
import type { RecentProject } from "@/bindings";
import { useProject } from "@/platform/project";
import { filterRecent, tildify } from "./recent";
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
