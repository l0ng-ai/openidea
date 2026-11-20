import { describe, expect, it } from "vitest";
import { parseSchemaTreeValue, schemaTreeRows, schemaTreeValue } from "./model";

describe("console database › schema switcher", () => {
  it("round-trips database and schema values", () => {
    expect(parseSchemaTreeValue(schemaTreeValue("shop"))).toEqual({ database: "shop", schema: null });
    expect(parseSchemaTreeValue(schemaTreeValue("shop", "public"))).toEqual({ database: "shop", schema: "public" });
    expect(parseSchemaTreeValue(schemaTreeValue("a.b", "c:d"))).toEqual({ database: "a.b", schema: "c:d" });
  });

  it("lists schemas under expanded databases only", () => {
    const schemas: Record<string, string[]> = { shop: ["public", "audit"], crm: ["public"] };
    const rows = schemaTreeRows(["shop", "crm"], new Set(["shop"]), (d) => schemas[d]);
    expect(rows.map((r) => [r.label, r.tree])).toEqual([
      ["shop", { depth: 0, expanded: true }],
      ["public", { depth: 1 }],
      ["audit", { depth: 1 }],
      ["crm", { depth: 0, expanded: false }],
    ]);
    expect(rows[1]!.value).toBe(schemaTreeValue("shop", "public"));
  });

  it("shows a disabled loading row while an expanded database's schemas load", () => {
    const rows = schemaTreeRows(["shop"], new Set(["shop"]), () => undefined);
    expect(rows[1]).toMatchObject({ label: "Loading…", disabled: true, tree: { depth: 1 } });
  });

  it("shows the error when an expanded database's schemas cannot be read", () => {
    const rows = schemaTreeRows(["shop"], new Set(["shop"]), () => ({ error: "timed out" }));
    expect(rows[1]).toMatchObject({ label: "timed out", verbatim: true, disabled: true });
  });

  it("lets a search for the database name keep its schemas", () => {
    const rows = schemaTreeRows(["shop"], new Set(["shop"]), () => ["public"]);
    expect(rows[1]).toMatchObject({ label: "public", keywords: "shop" });
  });
});
