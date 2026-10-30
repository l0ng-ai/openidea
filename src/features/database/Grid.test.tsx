import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Grid } from "./Grid";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

describe("database grid", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    disposers
      .splice(0)
      .reverse()
      .forEach((dispose) => dispose());
  });
  it("drags a rectangle and copies it as TSV through the Windows dispatcher", () => {
    useKeymap.setState({ preset: "intellij-windows", overrides: {} });
    const globalCopy = vi.fn();
    disposers.push(registerActions([{ id: "edit.copy", title: "Copy", run: globalCopy }]), installKeyboardDispatcher());
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
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", code: "KeyC", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("one\ttwo\nthree\tfour");
    expect(globalCopy).not.toHaveBeenCalled();
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
