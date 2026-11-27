import { describe, expect, it } from "vitest";
import { nodeSchema, routineFolder, tableFolder, type DbNode } from "./nodes";

describe("schema folders", () => {
  it("combines routines by default and separates them on request", () => {
    expect(routineFolder("procedure")).toBe("routines");
    expect(routineFolder("function")).toBe("routines");
    expect(routineFolder("procedure", true)).toBe("procedures");
    expect(routineFolder("function", true)).toBe("functions");
  });

  it("keeps tables, views and materialized views apart", () => {
    expect(tableFolder("table")).toBe("tables");
    expect(tableFolder("view")).toBe("views");
    expect(tableFolder("materializedView")).toBe("materializedViews");
  });
});

describe("the schema of a node", () => {
  it("is the schema it is or is inside of, none above schemas", () => {
    const schema: DbNode = { kind: "schema", key: "pg/sales", id: "pg", schema: "sales" };
    const folder: DbNode = { kind: "folder", key: "pg/sales/tables", id: "pg", schema: "sales", folder: "tables" };
    const database: DbNode = { kind: "database", key: "pg/shop", id: "pg:shop", name: "shop", current: true };
    expect(nodeSchema(schema)).toBe("sales");
    expect(nodeSchema(folder)).toBe("sales");
    expect(nodeSchema(database)).toBeNull();
  });
});
