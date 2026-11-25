import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction } from "@/platform/actions";
import type { DbColumnInfo, DbTableDetails } from "@/platform/ipc";
import { provideEditorService, type EditorInput } from "@/workbench/contributions";
import type { DbNode } from "./nodes";
import { detailsKey, tablesKey, useDatabase } from "./store";
import { registerDatabaseTreeActions } from "./treeActions";
import { nodeMenu } from "./treeMenu";
import type { DiagramData } from "./erDiagram";

const ui = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...actual, notifications: () => ({ notify: ui.notify }) };
});

const id = "pg";
const col = (name: string, primaryKey = false): DbColumnInfo => ({
  name,
  dataType: "integer",
  nullable: false,
  default: null,
  primaryKey,
});
const details = (columns: DbColumnInfo[], refTable?: string): DbTableDetails => ({
  columns,
  indexes: [],
  foreignKeys: refTable
    ? [{ schema: "public", table: "", columns: [columns[1]!.name], refSchema: "public", refTable, refColumns: ["id"] }]
    : [],
  triggers: [],
});
const tableNode = (name: string, kind: "table" | "view" = "table"): DbNode => ({
  kind: "table",
  key: `${id}/public/tables/${name}`,
  id,
  schema: "public",
  table: { name, kind },
});
const schema: DbNode = { kind: "schema", key: `${id}/public`, id, schema: "public" };
const folder = (f: "tables" | "routines"): DbNode => ({
  kind: "folder",
  key: `${id}/public/${f}`,
  id,
  schema: "public",
  folder: f,
});

const opened = vi.fn<(input: EditorInput) => void>();
const diagram = () => opened.mock.calls.at(-1)?.[0].data as DiagramData | undefined;
const showDiagram = (arg?: DbNode) => getAction("db.showDiagram")!.run({ arg } as never);

let dispose: () => void;
beforeEach(() => {
  dispose = registerDatabaseTreeActions();
  provideEditorService({ openInput: async (input: EditorInput) => opened(input) } as never);
  const tables = ["users", "orders", "audit"];
  useDatabase.setState({
    sources: [{ id, driver: "postgres" }],
    loaded: true,
    tables: {
      [tablesKey(id, "public")]: {
        status: "ok",
        value: [...tables.map((name) => ({ name, kind: "table" as const })), { name: "active_users", kind: "view" }],
      },
    },
    details: {
      [detailsKey(id, "public", "users")]: { status: "ok", value: details([col("id", true)]) },
      [detailsKey(id, "public", "orders")]: { status: "ok", value: details([col("id", true), col("uid")], "users") },
      [detailsKey(id, "public", "audit")]: { status: "ok", value: details([col("id"), col("oid")], "orders") },
      [detailsKey(id, "public", "active_users")]: { status: "ok", value: details([col("id")]) },
    },
    selectedNodes: [],
  });
});
afterEach(() => {
  dispose();
  opened.mockReset();
  ui.notify.mockReset();
});

const entities = (source: string) => [...source.matchAll(/^ {2}t\d+\["([^"]*)"\]/gm)].map((m) => m[1]);

describe("Diagrams › Show Diagram", () => {
  it("is in the Diagrams submenu of tables, schemas and table folders only", () => {
    const has = (n: DbNode) =>
      nodeMenu(n).some(
        (item) =>
          "submenu" in item &&
          item.label === "Diagrams" &&
          item.submenu?.some((s) => "action" in s && s.action === "db.showDiagram"),
      );
    expect([tableNode("users"), schema, folder("tables"), folder("routines")].map(has)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("shows the selected tables, linked only among themselves", async () => {
    const selection = [tableNode("orders"), tableNode("audit")];
    useDatabase.setState({ selectedNodes: selection });
    await showDiagram(selection[1]);
    expect(entities(diagram()!.source)).toEqual(["orders", "audit"]);
    expect(diagram()!.source).toContain('t0 ||--o{ t1 : "oid"');
    expect(diagram()!.source).not.toContain("users");
  });

  it("shows only the clicked table when it is outside the selection", async () => {
    useDatabase.setState({ selectedNodes: [tableNode("orders"), tableNode("audit")] });
    await showDiagram(tableNode("users"));
    expect(diagram()).toEqual({ title: "users", source: expect.stringContaining('t0["users"]') });
    expect(entities(diagram()!.source)).toEqual(["users"]);
  });

  it("shows every table of a schema, without its views", async () => {
    await showDiagram(schema);
    expect(diagram()!.title).toBe("public");
    expect(entities(diagram()!.source)).toEqual(["users", "orders", "audit"]);
    expect(diagram()!.source.match(/--o\{/g)).toHaveLength(2);
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("caps a large schema and says so", async () => {
    const names = Array.from({ length: 60 }, (_, i) => `t${i}`);
    useDatabase.setState({
      tables: { [tablesKey(id, "public")]: { status: "ok", value: names.map((name) => ({ name, kind: "table" })) } },
      details: Object.fromEntries(
        names.map((name) => [detailsKey(id, "public", name), { status: "ok", value: details([col("id")]) }]),
      ),
    });
    await showDiagram(schema);
    expect(entities(diagram()!.source)).toHaveLength(50);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Showing the first 50 of 60 tables in the diagram" }),
    );
  });

  it("leaves out tables that would take the source past Mermaid's size limit, and says so", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `wide_${i}`);
    const wide = Array.from({ length: 60 }, (_, i) => ({
      ...col(`column_with_a_long_name_${i}`),
      dataType: "varchar(255)",
    }));
    useDatabase.setState({
      tables: { [tablesKey(id, "public")]: { status: "ok", value: names.map((name) => ({ name, kind: "table" })) } },
      details: Object.fromEntries(
        names.map((name) => [detailsKey(id, "public", name), { status: "ok", value: details(wide) }]),
      ),
    });
    await showDiagram(schema);
    const { source } = diagram()!;
    const shown = entities(source).length;
    expect(source.length).toBeLessThanOrEqual(50_000);
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(20);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: `Showing the first ${shown} of 20 tables in the diagram` }),
    );
  });

  it("opens nothing without tables", async () => {
    await showDiagram(folder("routines"));
    expect(opened).not.toHaveBeenCalled();
  });
});
