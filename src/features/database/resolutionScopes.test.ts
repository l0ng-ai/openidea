import { beforeEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { resolutionScopeOf, validateResolutionScopes } from "./resolutionScopes";
import { bindConsole, consoleSchema, consoleSource, useDatabase } from "./store";

const scopes = validateResolutionScopes([
  { path: "", dataSource: "main", schema: "" },
  { path: "./src/main/resources/mapper/", dataSource: "orders", schema: "sales" },
  { path: "src/main/resources/mapper/legacy/Old.xml", dataSource: "legacy", schema: "" },
  { path: "src/gone", dataSource: "removed", schema: "" },
]);

describe("SQL resolution scopes", () => {
  it("normalises paths and picks the deepest folder or file covering a file, else the project row", () => {
    expect(scopes[1]!.path).toBe("src/main/resources/mapper");
    const at = (rel: string) => resolutionScopeOf(`/p/${rel}`, "/p", scopes)?.dataSource;
    expect(at("src/main/resources/mapper/UserMapper.xml")).toBe("orders");
    expect(at("src/main/resources/mapper/legacy/Old.xml")).toBe("legacy");
    expect(at("src/main/resources/mapper/legacy/New.xml")).toBe("orders");
    // A sibling folder whose name starts the same is not inside.
    expect(at("src/main/resources/mapperx/A.xml")).toBe("main");
    expect(resolutionScopeOf("/elsewhere/a.sql", "/p", scopes)).toBeNull();
  });

  it("skips rows whose data source no longer exists", () => {
    const known = (id: string) => id !== "removed";
    expect(resolutionScopeOf("/p/src/gone/a.sql", "/p", scopes, known)?.dataSource).toBe("main");
  });
});

describe("the data source a SQL file resolves against", () => {
  beforeEach(() => {
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true } as never,
      settings: { database: { resolutionScopes: scopes } } as never,
    });
    useDatabase.setState({
      sources: ["main", "orders", "legacy"].map((id) => ({ id, name: id, driver: "postgres" as const })),
      consoles: {},
      consoleSchemas: {},
      completion: { orders: { defaultSchema: "public", tables: [], foreignKeys: [] } },
    });
  });

  it("is the one picked in its toolbar, else its scope's (with the scope's schema)", () => {
    const file = "/p/src/main/resources/mapper/UserMapper.xml";
    expect(consoleSource(file)).toBe("orders");
    expect(consoleSchema(file)).toBe("sales");
    bindConsole(file, "legacy");
    expect(consoleSource(file)).toBe("legacy");
    bindConsole(file, null);
    expect(consoleSource("/p/scratch.sql")).toBe("main");
  });
});
