import { describe, expect, it } from "vitest";
import { routineFolder, tableFolder } from "./nodes";

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
