import { describe, expect, it } from "vitest";
import { selectRow, selectedRows } from "./rowSelection";

describe("list selection across sections", () => {
  it("selects only options across headers in either direction", () => {
    const rows = [
      { key: "files", section: true },
      { key: "a", section: false },
      { key: "symbols", section: true },
      { key: "b", section: false },
      { key: "actions", section: true },
      { key: "c", section: false },
    ];
    const single = { lead: 3, anchor: 3, keys: null };
    const section = (row: (typeof rows)[number]) => row.section;
    const down = selectRow(rows, single, 5, "range", section);
    expect(selectedRows(rows, down).map((r) => r.key)).toEqual(["b", "c"]);
    const up = selectRow(rows, down, 1, "range", section);
    expect(selectedRows(rows, up).map((r) => r.key)).toEqual(["a", "b"]);
    expect(selectRow(rows, up, 2, "toggle", section)).toBe(up);
  });
});
