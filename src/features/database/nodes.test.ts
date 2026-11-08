import { describe, expect, it } from "vitest";
import { routineFolder, tableFolder } from "./nodes";

describe("schema folders", () => {
  it("separates procedures and functions instead of a combined routines folder", () => {
    expect(routineFolder("procedure")).toBe("procedures");
    expect(routineFolder("function")).toBe("functions");
  });

  it("keeps tables, views and materialized views apart", () => {
    expect(tableFolder("table")).toBe("tables");
    expect(tableFolder("view")).toBe("views");
    expect(tableFolder("materializedView")).toBe("materializedViews");
  });
});
