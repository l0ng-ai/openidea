import type { DataSource } from "@/platform/ipc";
import { describe, expect, it } from "vitest";
import { consoleDecorations } from "./store";

describe("query console file decorations", () => {
  const source = { id: "pg", name: "Orders", driver: "postgres" } as DataSource;

  it("labels console folders with their data source instead of the physical data source id", () => {
    const decorations = consoleDecorations({
      sources: [source, { id: "analytics", name: "Analytics", driver: "postgres" } as DataSource],
      consoles: {
        "/data/scratches/consoles/db/pg/console.sql": "pg",
        "/data/scratches/consoles/db/pg.sales/console_1.sql": "pg:sales",
      },
    });

    expect(decorations.get("/data/scratches/consoles/db")).toMatchObject({
      label: "Database Consoles",
      icon: "db-folder",
    });
    expect(decorations.get("/data/scratches/consoles/db/pg")).toMatchObject({ label: "Orders", icon: "db-postgres" });
    // A data source whose console has not been opened still gets a readable folder name.
    expect(decorations.get("/data/scratches/consoles/db/analytics")).toMatchObject({ label: "Analytics" });
    expect(decorations.get("/data/scratches/consoles/db/pg.sales")).toMatchObject({
      label: "Orders: sales",
      icon: "db-postgres",
    });
    expect(decorations.get("/data/scratches/consoles/db/pg/console.sql")).toMatchObject({
      tabTitle: "console [Orders]",
    });
  });

  it("recognises Windows separators", () => {
    const decorations = consoleDecorations({
      sources: [source],
      consoles: { "C:\\Users\\me\\data\\scratches\\consoles\\db\\pg\\console.sql": "pg" },
    });

    expect(decorations.get("C:\\Users\\me\\data\\scratches\\consoles\\db")).toMatchObject({
      label: "Database Consoles",
    });
    expect(decorations.get("C:\\Users\\me\\data\\scratches\\consoles\\db\\pg")).toMatchObject({ label: "Orders" });
  });
});
