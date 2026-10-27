import { describe, expect, it } from "vitest";
import type { SyncEntry } from "@/platform/ipc";
import { DEFAULT_DEPLOYMENT, DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import {
  defaultSyncAction,
  initialSyncChoices,
  joinRemote,
  localPathForRemote,
  pathsFromArg,
  remoteName,
  remoteParent,
  resolveServer,
  sshRemedy,
  summarizeReport,
  syncChoices,
  syncSteps,
  targetPaths,
} from "./model";

const ROOT = "/work/app";

describe("targetPaths", () => {
  const ctx = { part: null, selection: [], editorPath: null, projectRoot: ROOT } as const;

  it("reads paths passed by menus", () => {
    expect(pathsFromArg(`${ROOT}/a.php`)).toEqual([`${ROOT}/a.php`]);
    expect(pathsFromArg([`${ROOT}/a`, 3, ""])).toEqual([`${ROOT}/a`]);
    expect(pathsFromArg({ paths: [`${ROOT}/b`] })).toEqual([`${ROOT}/b`]);
    expect(pathsFromArg(undefined)).toBeNull();
    expect(pathsFromArg({ paths: [] })).toBeNull();
  });

  it("prefers the passed paths over the selection and the editor", () => {
    expect(
      targetPaths(`${ROOT}/x`, { ...ctx, part: "project", selection: [`${ROOT}/y`], editorPath: `${ROOT}/z` }),
    ).toEqual([`${ROOT}/x`]);
  });

  it("uses the project view selection when it had focus last, else the editor file", () => {
    const both = { ...ctx, selection: [`${ROOT}/src`], editorPath: `${ROOT}/index.php` };
    expect(targetPaths(undefined, { ...both, part: "project" })).toEqual([`${ROOT}/src`]);
    expect(targetPaths(undefined, { ...both, part: "editor" })).toEqual([`${ROOT}/index.php`]);
    expect(targetPaths(undefined, { ...ctx, part: "editor", selection: [`${ROOT}/src`] })).toEqual([]);
  });

  it("drops paths outside the project and paths inside selected folders", () => {
    expect(targetPaths([`${ROOT}/src`, `${ROOT}/src/a.php`, "/elsewhere/b", `${ROOT}/srcx`], ctx)).toEqual([
      `${ROOT}/src`,
      `${ROOT}/srcx`,
    ]);
    expect(targetPaths(`${ROOT}/a`, { ...ctx, projectRoot: null })).toEqual([]);
  });
});

describe("sync defaults", () => {
  it("picks the action from the status", () => {
    expect(defaultSyncAction("localOnly")).toBe("upload");
    expect(defaultSyncAction("localNewer")).toBe("upload");
    expect(defaultSyncAction("different")).toBe("upload");
    expect(defaultSyncAction("remoteOnly")).toBe("download");
    expect(defaultSyncAction("remoteNewer")).toBe("download");
    expect(defaultSyncAction("same")).toBe("skip");
  });

  const entry = (path: string, status: SyncEntry["status"], local: boolean, remote: boolean): SyncEntry => ({
    path,
    remotePath: `/srv/${path}`,
    local: local ? { size: 1, mtime: 1 } : null,
    remote: remote ? { size: 2, mtime: 2 } : null,
    status,
  });

  it("offers only actions possible for the row", () => {
    expect(syncChoices(entry("a", "localOnly", true, false))).toEqual(["skip", "upload", "deleteLocal"]);
    expect(syncChoices(entry("b", "remoteOnly", false, true))).toEqual(["skip", "download", "deleteRemote"]);
  });

  it("turns choices into steps without the skipped rows", () => {
    const entries = [
      entry("a", "localOnly", true, false),
      entry("b", "same", true, true),
      entry("c", "remoteNewer", true, true),
    ];
    const choices = initialSyncChoices(entries);
    expect(choices).toEqual({ a: "upload", b: "skip", c: "download" });
    expect(syncSteps({ ...choices, b: "deleteRemote" })).toEqual([
      { path: "a", action: "upload" },
      { path: "b", action: "deleteRemote" },
      { path: "c", action: "download" },
    ]);
  });
});

describe("servers and reports", () => {
  const a = { ...DEFAULT_DEPLOYMENT_SERVER, id: "a", name: "Staging" };
  const b = { ...DEFAULT_DEPLOYMENT_SERVER, id: "b", name: "" };

  it("resolves the default server", () => {
    expect(resolveServer({ ...DEFAULT_DEPLOYMENT, servers: [a, b], defaultServer: "b" }, null)?.id).toBe("b");
    expect(resolveServer({ ...DEFAULT_DEPLOYMENT, servers: [a, b], defaultServer: "" }, null)).toBeNull();
    expect(resolveServer({ ...DEFAULT_DEPLOYMENT, servers: [a], defaultServer: "" }, null)?.id).toBe("a");
    expect(resolveServer({ ...DEFAULT_DEPLOYMENT, servers: [a, b], defaultServer: "b" }, "a")?.id).toBe("a");
  });

  it("summarizes transfer reports", () => {
    expect(summarizeReport({ files: 3, skipped: 1, errors: [] }, "upload", "Staging")).toEqual({
      level: "info",
      title: "Uploaded {n} files to {server}",
      params: { n: 3, server: "Staging", skipped: 1 },
    });
    expect(
      summarizeReport({ files: 2, skipped: 0, errors: [{ path: "x", message: "denied" }] }, "download", "S").level,
    ).toBe("warning");
    expect(
      summarizeReport({ files: 0, skipped: 0, errors: [{ path: "x", message: "denied" }] }, "sync", "S").level,
    ).toBe("error");
  });

  it("classifies SSH failures", () => {
    expect(sshRemedy("protocol", "Unknown SSH host key for example.com", "openSsh")).toBe("trustHostKey");
    expect(sshRemedy("permissionDenied", "SSH password required for deploy@example.com", "password")).toBe("secret");
    expect(sshRemedy("permissionDenied", "SSH key passphrase required for ~/.ssh/id", "keyPair")).toBe("secret");
    expect(sshRemedy("permissionDenied", "SSH host key of box:22 has changed", "password")).toBeNull();
    expect(sshRemedy("permissionDenied", "SSH authentication failed", "openSsh")).toBeNull();
    expect(sshRemedy("permissionDenied", "SSH authentication failed", "password")).toBe("secret");
    expect(sshRemedy("io", "Connection refused", "password")).toBeNull();
  });
});

describe("remote paths", () => {
  it("joins and splits remote paths", () => {
    expect(joinRemote("/var/www", "app/")).toBe("/var/www/app");
    expect(joinRemote("/", "etc")).toBe("/etc");
    expect(joinRemote("/var/www", "")).toBe("/var/www");
    expect(remoteParent("/var/www/app")).toBe("/var/www");
    expect(remoteParent("/var")).toBe("/");
    expect(remoteParent("/")).toBe("/");
    expect(remoteName("/var/www/app/")).toBe("app");
  });

  it("maps remote paths back to project paths through the most specific mapping", () => {
    const mappings = [
      { local: "", deployment: "", web: "" },
      { local: "public", deployment: "htdocs", web: "" },
      { local: "shared", deployment: "/opt/shared", web: "" },
    ];
    const map = (p: string) => localPathForRemote(p, "/var/www", mappings, ROOT);
    expect(map("/var/www/index.php")).toBe(`${ROOT}/index.php`);
    expect(map("/var/www/htdocs/css/a.css")).toBe(`${ROOT}/public/css/a.css`);
    expect(map("/var/www/htdocs")).toBe(`${ROOT}/public`);
    expect(map("/opt/shared/lib")).toBe(`${ROOT}/shared/lib`);
    expect(map("/var/wwwx/a")).toBeNull();
    expect(map("/etc/passwd")).toBeNull();
  });
});
