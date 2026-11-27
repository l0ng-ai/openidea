import { beforeEach, describe, expect, it, vi } from "vitest";
import { provideEditorService } from "@/workbench/contributions";
import { consoleSchema, newConsole, openConsole, useDatabase } from "./store";

const backend = vi.hoisted(() => ({ consoles: vi.fn(), consolePath: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, dbConsoles: backend.consoles, dbConsolePath: backend.consolePath },
  };
});

describe("the schema a query console starts in (#6329)", () => {
  beforeEach(() => {
    provideEditorService({ openFile: vi.fn(async () => {}) } as never);
    useDatabase.setState({
      sources: [{ id: "pg", name: "pg", driver: "postgres" }],
      consoles: {},
      consoleSchemas: {},
      completion: { pg: { defaultSchema: "public", tables: [], foreignKeys: [] } },
    });
  });

  it("is the given schema for a new console", async () => {
    backend.consoles.mockImplementation(async (_id: string, create: boolean) => ({
      status: "ok",
      data: create ? ["/c/console.sql", "/c/console_1.sql"] : ["/c/console.sql"],
    }));
    await newConsole("pg", "sales");
    expect(consoleSchema("/c/console_1.sql")).toBe("sales");
  });

  it("is the given schema for the default console, else the connection's default", async () => {
    backend.consolePath.mockResolvedValue({ status: "ok", data: "/c/console.sql" });
    await openConsole("pg");
    expect(consoleSchema("/c/console.sql")).toBe("public");
    await openConsole("pg", "sales");
    expect(consoleSchema("/c/console.sql")).toBe("sales");
  });
});
