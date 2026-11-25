import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction } from "@/platform/actions";
import type { DbColumnInfo, DbTableDetails } from "@/platform/ipc";
import { provideEditorService, type EditorInput } from "@/workbench/contributions";
import type { DbNode } from "./nodes";
import { detailsKey, tablesKey, useDatabase } from "./store";
import { registerDatabaseTreeActions } from "./treeActions";
import { nodeMenu } from "./treeMenu";
import { diagramModel, type DiagramData } from "./erDiagram";

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

const shownNames = (data = diagram()) => data?.tables.map((t) => t.name);

describe("Diagrams › Show Diagram", () => {
  it("is in the Diagrams submenu of tables, schemas and table folders only", () => {
    const has = (n: DbNode) =>
      nodeMenu(n).some(
        (item) =>
          "submenu" in item &&
          item.label === "Diagrams" &&
          ["db.showDiagram", "db.showDiagramPopup"].every((a) =>
            item.submenu?.some((s) => "action" in s && s.action === a),
          ),
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
    expect(shownNames()).toEqual(["orders", "audit"]);
    expect(diagramModel(diagram()!.tables).edges).toEqual([expect.objectContaining({ from: 1, to: 0 })]);
  });

  it("shows only the clicked table when it is outside the selection", async () => {
    useDatabase.setState({ selectedNodes: [tableNode("orders"), tableNode("audit")] });
    await showDiagram(tableNode("users"));
    expect(diagram()!.title).toBe("users");
    expect(shownNames()).toEqual(["users"]);
  });

  it("shows every table of a schema, without its views", async () => {
    await showDiagram(schema);
    expect(diagram()!.title).toBe("public");
    expect(shownNames()).toEqual(["users", "orders", "audit"]);
    expect(diagramModel(diagram()!.tables).edges).toHaveLength(2);
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
    expect(shownNames()).toHaveLength(50);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Showing the first 50 of 60 tables in the diagram" }),
    );
  });

  it("shows the same diagram in a popup, and gives the tab the same key whatever the selection order", async () => {
    const selection = [tableNode("orders"), tableNode("audit")];
    useDatabase.setState({ selectedNodes: selection });
    await getAction("db.showDiagramPopup")!.run({ arg: selection[0] } as never);
    expect(opened).not.toHaveBeenCalled();
    const popup = useDatabase.getState().dialog;
    expect(popup?.kind === "diagram" && shownNames(popup.data)).toEqual(["orders", "audit"]);
    useDatabase.setState({ dialog: null });
    await showDiagram(selection[0]);
    useDatabase.setState({ selectedNodes: [...selection].reverse() });
    await showDiagram(selection[0]);
    expect(opened.mock.calls[0]![0].key).toBe(opened.mock.calls[1]![0].key);
  });

  it("opens nothing without tables", async () => {
    await showDiagram(folder("routines"));
    expect(opened).not.toHaveBeenCalled();
  });
});
