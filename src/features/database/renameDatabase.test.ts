import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAction } from "@/platform/actions";
import type { DbNode } from "./nodes";
import { useDatabase } from "./store";
import { registerDatabaseTreeActions } from "./treeActions";
import { nodeMenu } from "./treeMenu";

const database = (current: boolean): DbNode => ({ kind: "database", key: "db", id: "pg:shop", name: "shop", current });
const schema: DbNode = { kind: "schema", id: "pg:shop", key: "schema", schema: "sales" };

const renameItem = (n: DbNode) =>
  nodeMenu(n).find((item) => "action" in item && item.action === "db.rename") as { disabled?: boolean } | undefined;

let dispose: () => void;
beforeEach(() => {
  dispose = registerDatabaseTreeActions();
  useDatabase.setState({ sources: [{ id: "pg", driver: "postgres" }], dialog: null, loaded: true });
});
afterEach(() => dispose());

describe("Rename on databases and schemas", () => {
  it("is offered on a database other than the connected one", () => {
    expect(renameItem(database(false))?.disabled).toBe(false);
    expect(renameItem(database(true))?.disabled).toBe(true);
  });

  it("is offered on a schema", () => {
    expect(renameItem(schema)?.disabled).toBe(false);
  });

  it("is not offered on a read-only data source", () => {
    useDatabase.setState({ sources: [{ id: "pg", driver: "postgres", readOnly: true }] });
    expect(renameItem(database(false))?.disabled).toBe(true);
  });

  it("opens the rename dialog through db.rename", async () => {
    await getAction("db.rename")!.run({ arg: database(false) } as never);
    expect(useDatabase.getState().dialog).toEqual({ kind: "renameDatabase", id: "pg", database: "shop" });
    useDatabase.setState({ dialog: null });
    await getAction("db.rename")!.run({ arg: database(true) } as never);
    expect(useDatabase.getState().dialog).toBeNull();
    await getAction("db.rename")!.run({ arg: schema } as never);
    expect(useDatabase.getState().dialog).toMatchObject({
      kind: "rename",
      id: "pg:shop",
      object: { kind: "schema", name: "sales" },
    });
  });
});
