import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Grid } from "./Grid";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

describe("database grid", () => {
  it("drags a rectangle and copies it as TSV", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <Grid
        columns={[
          { name: "a", type: "text" },
          { name: "b", type: "text" },
        ]}
        rowCount={2}
        value={(r, c) =>
          [
            ["one", "two"],
            ["three", "four"],
          ][r]![c]!
        }
      />,
    );
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[3]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", metaKey: true });
    expect(writeText).toHaveBeenCalledWith("one\ttwo\nthree\tfour");
  });
  it("pastes a rectangle as pending edits and skips deleted rows", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[
          { name: "a", type: "text" },
          { name: "b", type: "text" },
        ]}
        rowCount={2}
        value={() => "old"}
        editable
        onEdit={onEdit}
        rowState={(r) => (r === 1 ? "deleted" : null)}
      />,
    );
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[0]!, { button: 0 });
    fireEvent.paste(screen.getByRole("grid"), { clipboardData: { getData: () => "new\tother\nignored\tignored" } });
    expect(onEdit.mock.calls).toEqual([
      [0, 0, "new"],
      [0, 1, "other"],
    ]);
  });
});
