import { describe, expect, it } from "vitest";
import type { RemoteEntry } from "@/platform/ipc";
import {
  initializeRemoteTrustMigration,
  takeLegacyRemoteTrust,
  forgetRemote,
  parseRemoteLocation,
  recentRemotes,
  rememberRemote,
  remoteLocation,
} from "@/platform/remote";
import { browsableFolders, listedDirectory, remoteParent } from "./model";
import { remoteBadge } from "./RemoteStatus";

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

const ssh = (config: string) => ({ kind: "ssh", config }) as const;
const wsl = (distro: string) => ({ kind: "wsl", distro }) as const;

describe("remote project locations", () => {
  it("round-trip the configuration id and the path", () => {
    const loc = remoteLocation(ssh("mac mini/1"), "/Users/me/repo");
    expect(loc).toBe("ssh://mac%20mini%2F1/Users/me/repo");
    expect(parseRemoteLocation(loc)).toEqual({ target: ssh("mac mini/1"), path: "/Users/me/repo" });
    expect(parseRemoteLocation("/Users/me/repo")).toBeNull();
  });

  it("round-trip a WSL distribution and the path", () => {
    const loc = remoteLocation(wsl("Ubuntu-24.04"), "/home/me/app");
    expect(loc).toBe("wsl://Ubuntu-24.04/home/me/app");
    expect(parseRemoteLocation(loc)).toEqual({ target: wsl("Ubuntu-24.04"), path: "/home/me/app" });
    expect(parseRemoteLocation("wsl://Ubuntu")).toBeNull();
  });

  it("remembers recent remote projects most recent first, once each", () => {
    localStorage.clear();
    rememberRemote({ target: ssh("a"), path: "/p", name: "p", host: "me@a", openedAtMs: 1 });
    rememberRemote({ target: ssh("b"), path: "/q", name: "q", host: "me@b", openedAtMs: 2 });
    rememberRemote({ target: ssh("a"), path: "/p", name: "p", host: "me@a", openedAtMs: 3 });
    expect(recentRemotes().map((r) => r.path)).toEqual(["/p", "/q"]);
    forgetRemote(ssh("a"), "/p");
    expect(recentRemotes().map((r) => r.path)).toEqual(["/q"]);
  });

  it("keeps an SSH host and a WSL distribution of the same name apart", () => {
    localStorage.clear();
    rememberRemote({ target: ssh("dev"), path: "/p", name: "p", host: "me@dev", openedAtMs: 1 });
    rememberRemote({ target: wsl("dev"), path: "/p", name: "p", host: "dev", openedAtMs: 2 });
    expect(recentRemotes()).toHaveLength(2);
    forgetRemote(wsl("dev"), "/p");
    expect(recentRemotes().map((r) => r.target)).toEqual([ssh("dev")]);
  });

  it("reads recents saved before WSL support, which carried `sshConfig`", () => {
    localStorage.clear();
    localStorage.setItem(
      "openidea.remote.recent",
      JSON.stringify([
        { sshConfig: "old", path: "/p", name: "p", host: "me@old", openedAtMs: 1 },
        { path: "/no-target" },
      ]),
    );
    expect(recentRemotes().map((r) => r.target)).toEqual([ssh("old")]);
  });
});

it("migrates only the original remote recents once, scoped to the saved host", () => {
  localStorage.clear();
  rememberRemote({ target: ssh("a"), path: "/old", host: "me@old", name: "old", openedAtMs: 1 });
  initializeRemoteTrustMigration();
  rememberRemote({ target: ssh("a"), path: "/new", host: "me@old", name: "new", openedAtMs: 2 });
  initializeRemoteTrustMigration();
  expect(takeLegacyRemoteTrust(ssh("a"), "/new", "me@old")).toBe(false);
  expect(takeLegacyRemoteTrust(ssh("a"), "/old", "me@other")).toBe(false);
  expect(takeLegacyRemoteTrust(ssh("a"), "/old", "me@old")).toBe(true);
  expect(takeLegacyRemoteTrust(ssh("a"), "/old", "me@old")).toBe(false);
});

it("migrates a snapshot taken before WSL support, and never trusts a WSL distribution", () => {
  localStorage.clear();
  localStorage.setItem(
    "openidea.remote.trustMigration",
    JSON.stringify([{ sshConfig: "a", path: "/old", host: "me@old", name: "old", openedAtMs: 1 }]),
  );
  expect(takeLegacyRemoteTrust(wsl("a"), "/old", "me@old")).toBe(false);
  expect(takeLegacyRemoteTrust(ssh("a"), "/old", "me@old")).toBe(true);
});

it("labels the status bar with the transport and where the project runs", () => {
  expect(remoteBadge({ target: wsl("Ubuntu"), host: "Ubuntu" })).toBe("WSL: Ubuntu");
  expect(remoteBadge({ target: ssh("a"), host: "me@a:22" })).toBe("SSH: me@a:22");
});
