import { describe, expect, it } from "vitest";
import { filterColumns } from "./ColumnsPopup";

const columns = ["id", "user_id", "name", "created_at", "username"].map((name) => ({ name, type: "TEXT" }));

describe("filterColumns", () => {
  it("lists every column for an empty query", () => {
    expect(filterColumns(columns, " ")).toEqual([0, 1, 2, 3, 4]);
  });

  it("puts prefix matches first, then other matches, ignoring case", () => {
    expect(filterColumns(columns, "US")).toEqual([1, 4]);
    expect(filterColumns(columns, "name")).toEqual([2, 4]);
    expect(filterColumns(columns, "_id")).toEqual([1]);
  });
});
