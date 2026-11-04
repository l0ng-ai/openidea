import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Grid } from "./Grid";
import { CELL_PREVIEW_LIMIT, cellPreview } from "./cellPreview";
import { exportData } from "./export";

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

describe("large database cells", () => {
  const full = JSON.stringify({ text: "\u8bf4\u660e text \u6df7\u5408 ".repeat(200_000), tail: "complete" });
  const columns = [{ name: "payload", type: "jsonb" }];

  it("preserves short values and truncates only beyond the preview limit", () => {
    for (const value of ["", "hello", "\u4e2d".repeat(CELL_PREVIEW_LIMIT)]) expect(cellPreview(value)).toBe(value);
    expect(cellPreview(full)).toBe(full.slice(0, CELL_PREVIEW_LIMIT) + "\u2026");
    expect(cellPreview("a".repeat(999) + "\ud83d\ude00tail")).toBe("a".repeat(999) + "\u2026");
  });

  it("bounds rendered text while copying and exporting the complete value", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<Grid columns={columns} rowCount={1} value={() => full} />);
    const cell = screen.getByRole("gridcell");
    expect(cell.textContent).toBe(cellPreview(full));
    expect(cell.title).toBe(full.slice(0, 2000));
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith(full);
    expect(JSON.parse(exportData("json", { columns, rows: [[full]], table: "big", driver: "postgres" }))).toEqual([
      { payload: full },
    ]);
  });

  it("edits the full large value in a dialog and supports cancel and apply", () => {
    const onEdit = vi.fn();
    render(<Grid columns={columns} rowCount={1} value={() => full} editable onEdit={onEdit} />);
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe(full);
    fireEvent.change(editor, { target: { value: full + "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: full + "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, full + "changed");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps short values in the inline editor and preserves null display", () => {
    const onEdit = vi.fn();
    const { rerender } = render(<Grid columns={columns} rowCount={1} value={() => "short"} editable onEdit={onEdit} />);
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    expect(screen.getByRole("textbox").tagName).toBe("INPUT");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "updated" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith(0, 0, "updated");
    rerender(<Grid columns={columns} rowCount={1} value={() => null} />);
    expect(screen.getByRole("gridcell").textContent).toBe("<null>");
  });
});

describe("multi-line database cells", () => {
  const columns = [{ name: "note", type: "text" }];
  const multi = "first line\nsecond line\r\nthird";

  it("shows line breaks as markers on one line", () => {
    render(<Grid columns={columns} rowCount={1} value={() => multi} />);
    expect(screen.getByRole("gridcell").textContent).toBe("first line↵second line↵third");
  });

  it.each([
    ["LF", "a\nb", "a\nb\nc"],
    ["CRLF, kept although the textarea uses LF", "a\r\nb", "a\r\nb\r\nc"],
  ])("edits a multi-line value (%s) in the multi-line editor and keeps its line breaks", (_, value, saved) => {
    const onEdit = vi.fn();
    render(<Grid columns={columns} rowCount={1} value={() => value} editable onEdit={onEdit} />);
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    fireEvent.change(editor, { target: { value: "a\nb\nc" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(onEdit).toHaveBeenCalledWith(0, 0, saved);
  });

  it("opens the multi-line editor with Shift+Enter, from the grid and from the inline editor", () => {
    const onEdit = vi.fn();
    render(<Grid columns={columns} rowCount={1} value={() => "one"} editable onEdit={onEdit} />);
    fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter", shiftKey: true });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const inline = screen.getByRole("textbox");
    expect(inline.tagName).toBe("INPUT");
    fireEvent.change(inline, { target: { value: "one two" } });
    fireEvent.keyDown(inline, { key: "Enter", shiftKey: true });
    fireEvent.blur(inline);
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("one two");
    expect(onEdit).not.toHaveBeenCalled();
  });
});
