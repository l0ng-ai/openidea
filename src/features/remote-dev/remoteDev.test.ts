import { describe, expect, it } from "vitest";
import type { RemoteEntry } from "@/platform/ipc";
import { forgetRemote, parseRemoteLocation, recentRemotes, rememberRemote, remoteLocation } from "@/platform/remote";
import { browsableFolders, listedDirectory, remoteParent } from "./model";

const entry = (path: string, isDir = true): RemoteEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir,
  isSymlink: false,
  size: 0,
  mtime: null,
  permissions: "rwxr-xr-x",
});

describe("remote folder browser", () => {
  it("goes up one level and stops at the root", () => {
    expect(remoteParent("/home/dev/app")).toBe("/home/dev");
    expect(remoteParent("/home/dev/")).toBe("/home");
    expect(remoteParent("/home")).toBe("/");
    expect(remoteParent("/")).toBe("/");
  });

  it("lists folders only, hidden ones last", () => {
    const names = browsableFolders([
      entry("/h/.cache"),
      entry("/h/zeta"),
      entry("/h/notes.txt", false),
      entry("/h/alpha"),
    ]).map((e) => e.name);
    expect(names).toEqual(["alpha", "zeta", ".cache"]);
  });

  it("resolves `~` from the listing", () => {
    expect(listedDirectory("~", [entry("/home/dev/app")])).toBe("/home/dev");
    expect(listedDirectory("~", [])).toBe("~");
    expect(listedDirectory("/srv/", [])).toBe("/srv");
    expect(listedDirectory("/", [])).toBe("/");
  });
});

describe("remote project locations", () => {
  it("round-trip the configuration id and the path", () => {
    const loc = remoteLocation("mac mini/1", "/Users/me/repo");
    expect(loc).toBe("ssh://mac%20mini%2F1/Users/me/repo");
    expect(parseRemoteLocation(loc)).toEqual({ sshConfig: "mac mini/1", path: "/Users/me/repo" });
    expect(parseRemoteLocation("/Users/me/repo")).toBeNull();
  });

  it("remembers recent remote projects most recent first, once each", () => {
    localStorage.clear();
    rememberRemote({ sshConfig: "a", path: "/p", name: "p", host: "me@a", openedAtMs: 1 });
    rememberRemote({ sshConfig: "b", path: "/q", name: "q", host: "me@b", openedAtMs: 2 });
    rememberRemote({ sshConfig: "a", path: "/p", name: "p", host: "me@a", openedAtMs: 3 });
    expect(recentRemotes().map((r) => r.path)).toEqual(["/p", "/q"]);
    forgetRemote("a", "/p");
    expect(recentRemotes().map((r) => r.path)).toEqual(["/q"]);
  });
});
