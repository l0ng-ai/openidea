import { describe, expect, it } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import {
  addMapping,
  fixDefaultServer,
  folderWithin,
  formatExcludes,
  newGroup,
  newServer,
  nextServerName,
  parseExcludes,
  pruneGroups,
  remoteParent,
  removeMapping,
  toggleGroupServer,
  updateMapping,
} from "./deploymentModel";

describe("server groups", () => {
  const servers = ["a", "b", "c"].map((id) => ({ ...DEFAULT_DEPLOYMENT_SERVER, id, name: id }));
  it("names a new group after the first free number", () => {
    const g = newGroup([{ id: "x", name: "Group 2", servers: [] }]);
    expect(g.name).toBe("Group 3");
    expect(g.servers).toEqual([]);
    expect(g.id).toMatch(/^group-/);
  });
  it("toggles members, keeping the server list's order", () => {
    let g = { id: "g", name: "G", servers: [] as string[] };
    g = toggleGroupServer(g, "c", servers);
    g = toggleGroupServer(g, "a", servers);
    expect(g.servers).toEqual(["a", "c"]);
    expect(toggleGroupServer(g, "a", servers).servers).toEqual(["c"]);
  });
  it("drops removed servers from groups and keeps untouched groups as they are", () => {
    const keep = { id: "k", name: "K", servers: ["a"] };
    const pruned = pruneGroups([keep, { id: "g", name: "G", servers: ["a", "b"] }], servers.slice(0, 1));
    expect(pruned[0]).toBe(keep);
    expect(pruned[1]!.servers).toEqual(["a"]);
  });
});

describe("exclude names", () => {
  it("parses a ;-separated list", () => {
    expect(parseExcludes(".git; .idea;;*.pyc ;")).toEqual([".git", ".idea", "*.pyc"]);
    expect(parseExcludes("")).toEqual([]);
    expect(parseExcludes("a;a;b")).toEqual(["a", "b"]);
  });

  it("formats and round-trips", () => {
    const names = [".git", "*.log", "node_modules"];
    expect(formatExcludes(names)).toBe(".git;*.log;node_modules");
    expect(parseExcludes(formatExcludes(names))).toEqual(names);
  });
});

describe("mappings table", () => {
  const rows = [
    { local: "", deployment: "", web: "" },
    { local: "public", deployment: "htdocs", web: "/" },
  ];

  it("edits one cell", () => {
    const next = updateMapping(rows, 1, { deployment: "www" });
    expect(next[1]).toEqual({ local: "public", deployment: "www", web: "/" });
    expect(next[0]).toBe(rows[0]);
    expect(rows[1]!.deployment).toBe("htdocs");
  });

  it("adds and removes rows", () => {
    expect(addMapping(rows)).toHaveLength(3);
    expect(addMapping(rows)[2]).toEqual({ local: "", deployment: "", web: "" });
    expect(removeMapping(rows, 0)).toEqual([rows[1]]);
    expect(removeMapping(rows, 5)).toEqual(rows);
  });
});

describe("server list", () => {
  const a = { ...DEFAULT_DEPLOYMENT_SERVER, id: "a", name: "Server 1" };

  it("names new servers and copies existing ones", () => {
    expect(nextServerName([a])).toBe("Server 2");
    expect(nextServerName([{ ...a, name: "Server 2" }])).toBe("Server 3");
    const fresh = newServer([a]);
    expect(fresh.kind).toBe("sftp");
    expect(fresh.name).toBe("Server 2");
    expect(fresh.id).not.toBe("");
    expect(fresh.mappings).toEqual([{ local: "", deployment: "", web: "" }]);
    expect(fresh.mappings).not.toBe(DEFAULT_DEPLOYMENT_SERVER.mappings);
    const copy = newServer([a], { ...a, rootPath: "/srv", excludedPaths: ["/srv/cache"] });
    expect(copy).toMatchObject({ name: "Server 1 (copy)", rootPath: "/srv", excludedPaths: ["/srv/cache"] });
    expect(copy.id).not.toBe("a");
  });

  it("copies a local server without changing its type or mappings", () => {
    const local = { ...a, kind: "local" as const, rootPath: "/mounted/www" };
    const copy = newServer([local], local);
    expect(copy).toMatchObject({ kind: "local", rootPath: "/mounted/www", sshConfig: "" });
    expect(copy.mappings).toEqual(local.mappings);
    expect(copy.mappings).not.toBe(local.mappings);
  });

  it("keeps the default server valid", () => {
    expect(fixDefaultServer([a], "a")).toBe("a");
    expect(fixDefaultServer([a], "gone")).toBe("a");
    expect(fixDefaultServer([], "a")).toBe("");
  });

  it("walks up remote folders", () => {
    expect(remoteParent("/var/www/")).toBe("/var");
    expect(remoteParent("/var")).toBe("/");
  });
});

describe("chosen mapping folders", () => {
  it("are relative to the project or the server's root path", () => {
    expect(folderWithin("/work/shop", "/work/shop/web/public")).toBe("web/public");
    expect(folderWithin("/var/www/", "/var/www/site")).toBe("site");
    expect(folderWithin("/var/www", "/var/www/")).toBe("");
    expect(folderWithin("/var/www", "/var/wwwroot")).toBeNull();
    expect(folderWithin("/var/www", "/srv")).toBeNull();
    expect(folderWithin("", "/srv")).toBeNull();
  });
});
