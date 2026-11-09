import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ContextMenuHost } from "@/ui";
import { DataView } from "./DataView";
import { Grid } from "./Grid";
import { CELL_PREVIEW_LIMIT, cellPreview } from "./cellPreview";
import { exportData } from "./export";
import { NULL_INPUT } from "./cellEditors";

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
  it("copies the selection in the extractor's format for plain ⌘C", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const data = [
      ["1", "Shanghai"],
      ["2", "Bei'jing"],
      ["3", null],
    ];
    render(
      <Grid
        columns={[
          { name: "id", type: "INTEGER" },
          { name: "city", type: "TEXT" },
        ]}
        rowCount={3}
        value={(r, c) => data[r]![c]!}
        copyFormat="onerow"
      />,
    );
    const cells = screen.getAllByRole("gridcell");
    // A column of three cells: the values on one line.
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[4]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("1, 2, 3");
    // Text values are single-quoted with `'` doubled; nulls are NULL.
    writeText.mockClear();
    fireEvent.mouseDown(cells[1]!, { button: 0 });
    fireEvent.mouseEnter(cells[5]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("'Shanghai', 'Bei''jing', NULL");
    // Several columns join in reading order, all on one line.
    writeText.mockClear();
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[3]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("1, 'Shanghai', 2, 'Bei''jing'");
  });
  it("copies a selection as CSV with ⌘C when the extractor is csv", () => {
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
        copyFormat="csv"
      />,
    );
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[3]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "c", ctrlKey: true });
    expect(writeText).toHaveBeenCalledWith("one,two\r\nthree,four");
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
describe("result grid search", () => {
  const columns = [
    { name: "city", type: "text" },
    { name: "n", type: "int" },
  ];
  const data = [
    ["Shanghai", "1"],
    ["Beijing", "2"],
    ["Shenzhen", "3"],
    ["Hangzhou", "4"],
  ];
  const value = (r: number, c: number) => data[r]?.[c] ?? null;

  it("opens the search bar on Ctrl+F and highlights the matches of the page", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <DataView
          columns={columns}
          rowCount={4}
          value={value}
          panel={null}
          onPanelChange={() => {}}
          searchOpen={open}
          onSearchOpenChange={setOpen}
        />
      );
    }
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Search in results" });
    fireEvent.change(input, { target: { value: "sh" } });
    const marked = () =>
      screen
        .getAllByRole("gridcell")
        .filter((c) => /cellMatch/.test(c.className))
        .map((c) => c.textContent);
    expect(marked()).toEqual(["Shanghai", "Shenzhen"]);
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();

    // Match Case: "sh" no longer matches "Sh…".
    fireEvent.click(screen.getByRole("button", { name: /Match Case/ }));
    expect(marked()).toEqual([]);
    expect(screen.getByText("0 results")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Match Case/ }));

    // Filter rows keeps only the rows with a match.
    fireEvent.click(screen.getByRole("checkbox", { name: "Filter rows" }));
    expect(screen.getAllByRole("row").length - 1).toBe(2);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.getAllByRole("row").length - 1).toBe(4);
  });
});

describe("boolean cells (issue #2331, phase 1)", () => {
  const values = [null, "t", "f"];

  it("shows a checkbox on editable boolean cells and toggles it, writing the driver's literals", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "ok", type: "boolean" }]}
        rowCount={3}
        value={(r) => values[r] ?? null}
        editable
        onEdit={onEdit}
        driver="postgres"
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    expect(boxes[0]!.indeterminate).toBe(true); // NULL
    fireEvent.click(boxes[2]!);
    expect(onEdit).toHaveBeenCalledWith(2, 0, "t");
    expect(onEdit).toHaveBeenCalledTimes(1); // the click toggles only, it doesn't open an editor
  });

  it("keeps read-only and deleted boolean cells as text without a checkbox", () => {
    render(<Grid columns={[{ name: "ok", type: "boolean" }]} rowCount={1} value={() => "t"} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("gridcell").textContent).toBe("t");
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "ok", type: "boolean" }]}
        rowCount={2}
        value={() => "f"}
        editable
        onEdit={onEdit}
        rowState={(r) => (r === 0 ? "deleted" : null)}
      />,
    );
    expect(screen.getAllByRole("checkbox").length).toBe(1);
  });

  it("toggles the lead boolean cell with Space", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "ok", type: "boolean" }]}
        rowCount={3}
        value={(r) => values[r] ?? null}
        editable
        onEdit={onEdit}
        driver="postgres"
      />,
    );
    // NULL flips to true, false flips back to true.
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[0]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: " " });
    expect(onEdit).toHaveBeenCalledWith(0, 0, "t");
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[2]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: " " });
    expect(onEdit).toHaveBeenCalledWith(2, 0, "t");
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it("edits a boolean cell in a true / false / NULL drop-down", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "ok", type: "boolean" }]}
        rowCount={1}
        value={() => "f"}
        editable
        onEdit={onEdit}
        driver="postgres"
      />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const select = screen.getByRole("combobox", { name: "Edit ok" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["t", "f", "NULL"]);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    fireEvent.change(screen.getByRole("combobox", { name: "Edit ok" }), { target: { value: NULL_INPUT } });
    expect(onEdit).toHaveBeenCalledWith(0, 0, null);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("omits the NULL option for a NOT NULL boolean column", () => {
    render(
      <Grid
        columns={[{ name: "ok", type: "tinyint(1)", nullable: false }]}
        rowCount={1}
        value={() => "0"}
        editable
        onEdit={vi.fn()}
        driver="mysql"
      />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const select = screen.getByRole("combobox", { name: "Edit ok" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["1", "0"]);
  });
});

describe("enum cells (issue #2331, phase 1)", () => {
  it("offers the type's values in a drop-down and commits the pick", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "mood", type: "enum('sad','ok','happy')" }]}
        rowCount={1}
        value={() => "sad"}
        editable
        onEdit={onEdit}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const select = screen.getByRole("combobox", { name: "Edit mood" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["sad", "ok", "happy", "NULL"]);
    expect(select.value).toBe("sad");
    fireEvent.change(select, { target: { value: "happy" } });
    expect(onEdit).toHaveBeenCalledWith(0, 0, "happy");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("keeps a value the drop-down doesn't know selectable and prefers explicit enumValues", () => {
    const onEdit = vi.fn();
    render(
      <Grid
        columns={[{ name: "mood", type: "mood", enumValues: ["calm", "angry"] }]}
        rowCount={1}
        value={() => "moody"}
        editable
        onEdit={onEdit}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const select = screen.getByRole("combobox", { name: "Edit mood" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["moody", "calm", "angry", "NULL"]);
    expect(select.value).toBe("moody");
    fireEvent.blur(select);
    expect(onEdit).toHaveBeenCalledWith(0, 0, "moody"); // leaving without picking changes nothing
  });

  it("falls back to the text editor for a value-less type", () => {
    render(
      <Grid columns={[{ name: "mood", type: "mood" }]} rowCount={1} value={() => "ok"} editable onEdit={vi.fn()} />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    expect(screen.getByRole("textbox").tagName).toBe("INPUT");
  });
});

describe("Set NULL / Set DEFAULT (issue #2331, phase 1)", () => {
  const columns = [
    { name: "a", type: "text", default: "'x'::text" },
    { name: "b", type: "int", nullable: false },
    { name: "c", type: "text", default: "now()" },
  ];

  it("sets NULL on the selection from the context menu and ⌘⌫, skipping NOT NULL columns", async () => {
    const onEdit = vi.fn();
    render(
      <>
        <Grid columns={columns} rowCount={1} value={() => "old"} editable onEdit={onEdit} />
        <ContextMenuHost />
      </>,
    );
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", ctrlKey: true });
    expect(onEdit).toHaveBeenCalledTimes(1); // only column a; b is NOT NULL
    expect(onEdit).toHaveBeenCalledWith(0, 0, null);

    fireEvent.mouseDown(cells[1]!, { button: 0 }); // column b, NOT NULL
    fireEvent.contextMenu(screen.getByRole("grid"), { clientX: 5, clientY: 5 });
    const entry = screen.getByRole("menuitem", { name: /Set NULL/ });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    await act(async () => void fireEvent.click(entry));
    expect(onEdit).toHaveBeenCalledTimes(1); // the disabled item changes nothing
  });

  it("sets DEFAULT from the context menu and ⇧⌘⌫: literals, added rows, never expressions", async () => {
    const onEdit = vi.fn();
    render(
      <>
        <Grid
          columns={columns}
          rowCount={2}
          value={() => "old"}
          editable
          onEdit={onEdit}
          rowState={(r) => (r === 1 ? "inserted" : null)}
        />
        <ContextMenuHost />
      </>,
    );
    const cells = screen.getAllByRole("gridcell");
    // Row 1 is an added row: its cells drop their value so the DB default applies.
    fireEvent.mouseDown(cells[4]!, { button: 0 }); // row 1, column b (no default of its own)
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", ctrlKey: true, shiftKey: true });
    expect(onEdit).toHaveBeenCalledWith(1, 1, null);
    expect(onEdit).toHaveBeenCalledTimes(1);

    // Row 0: column a's default is a literal; column c's is an expression and stays.
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.contextMenu(screen.getByRole("grid"), { clientX: 5, clientY: 5 });
    await act(async () => void fireEvent.click(screen.getByRole("menuitem", { name: /Set DEFAULT/ })));
    expect(onEdit).toHaveBeenCalledWith(0, 0, "x");
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it("disables Set DEFAULT when no selected column has a usable default", async () => {
    const onEdit = vi.fn();
    render(
      <>
        <Grid columns={[columns[2]!]} rowCount={1} value={() => "old"} editable onEdit={onEdit} />
        <ContextMenuHost />
      </>,
    );
    fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
    fireEvent.contextMenu(screen.getByRole("grid"), { clientX: 5, clientY: 5 });
    const entry = screen.getByRole("menuitem", { name: /Set DEFAULT/ });
    expect(entry.getAttribute("aria-disabled")).toBe("true");
    await act(async () => void fireEvent.click(entry));
    expect(onEdit).not.toHaveBeenCalled();
  });
});
