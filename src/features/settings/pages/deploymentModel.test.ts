import { describe, expect, it } from "vitest";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";
import {
  addMapping,
  fixDefaultServer,
  formatExcludes,
  newServer,
  nextServerName,
  parseExcludes,
  remoteParent,
  removeMapping,
  updateMapping,
} from "./deploymentModel";

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
    expect(fresh.name).toBe("Server 2");
    expect(fresh.id).not.toBe("");
    expect(fresh.mappings).toEqual([{ local: "", deployment: "", web: "" }]);
    expect(fresh.mappings).not.toBe(DEFAULT_DEPLOYMENT_SERVER.mappings);
    const copy = newServer([a], { ...a, rootPath: "/srv", excludedPaths: ["/srv/cache"] });
    expect(copy).toMatchObject({ name: "Server 1 (copy)", rootPath: "/srv", excludedPaths: ["/srv/cache"] });
    expect(copy.id).not.toBe("a");
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
