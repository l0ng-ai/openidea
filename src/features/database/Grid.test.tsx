import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { EditorView } from "@codemirror/view";
import { DataView } from "./DataView";
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
    const large = "word ".repeat(40_000); // not JSON: the plain multi-line editor
    render(
      <Grid columns={[{ name: "note", type: "text" }]} rowCount={1} value={() => large} editable onEdit={onEdit} />,
    );
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe(large);
    fireEvent.change(editor, { target: { value: large + "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: large + "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, large + "changed");
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
describe("JSON value editor (#2333)", () => {
  const json = '{"name":"Ada","tags":["math","code"]}';
  const pretty = JSON.stringify(JSON.parse(json), null, 2);
  const payload = [{ name: "payload", type: "jsonb" }];
  // CodeMirror renders each line in its own element: compare text without layout whitespace.
  const shown = (text: string) => text.replace(/\s+/g, "");

  /** The mounted CodeMirror view of the open editor. */
  const view = () => {
    const content = document.querySelector(".cm-content") as HTMLElement;
    return EditorView.findFromDOM(content)!;
  };
  const editDoc = (insert: string) => {
    const v = view();
    act(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert } }));
  };
  const openWindow = () => {
    fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Enter", shiftKey: true });
  };

  it("opens the JSON window with Shift+Enter, pretty-printed, and applies edits to the grid", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={onEdit} />);
    openWindow();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // The code editor, not the plain textarea: a contenteditable div, pretty-printed.
    const editor = screen.getByRole("textbox", { name: "Edit payload" });
    expect(editor.tagName).toBe("DIV");
    expect(shown(editor.textContent ?? "")).toBe(shown(pretty));
    editDoc(pretty.replace('"Ada"', '"Grace"'));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, pretty.replace('"Ada"', '"Grace"'));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks invalid JSON and blocks Apply until it parses", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={onEdit} />);
    openWindow();
    const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply().disabled).toBe(true); // unchanged
    editDoc('{"broken": ');
    expect(apply().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/JSON/i);
    fireEvent.click(apply());
    expect(onEdit).not.toHaveBeenCalled();
    editDoc('{"ok": 1}');
    expect(apply().disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(apply());
    expect(onEdit).toHaveBeenCalledWith(0, 0, '{"ok": 1}');
  });

  it("reformats the edited text in the window", () => {
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={vi.fn()} />);
    openWindow();
    editDoc('{"a":1}');
    fireEvent.click(screen.getByRole("button", { name: "Reformat" }));
    expect(shown(screen.getByRole("textbox", { name: "Edit payload" }).textContent ?? "")).toBe(
      shown('{\n  "a": 1\n}'),
    );
  });

  it("shows formatted JSON in the Value panel with Reformat, Open in Window and guarded Apply", () => {
    const onEdit = vi.fn();
    const columns = [
      { name: "id", type: "int4" },
      { name: "payload", type: "jsonb" },
    ];
    const data = [["1", json]];
    render(
      <DataView
        columns={columns}
        rowCount={1}
        value={(r, c) => data[r]![c]!}
        panel="value"
        onPanelChange={() => {}}
        editable
        onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[1]!, { button: 0 });
    const editor = screen.getByRole("textbox", { name: "Value of payload" });
    expect(shown(editor.textContent ?? "")).toBe(shown(pretty));
    const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply().disabled).toBe(true);
    editDoc(pretty.replace('"Ada"', '"Grace"'));
    expect(apply().disabled).toBe(false);
    fireEvent.click(apply());
    expect(onEdit).toHaveBeenCalledWith(0, 1, pretty.replace('"Ada"', '"Grace"'));
    // The panel editor restarts on the committed value.
    expect(shown(editor.textContent ?? "")).toBe(shown(pretty.replace('"Ada"', '"Grace"')));
    // The same editor in a larger, resizable window.
    fireEvent.click(screen.getByRole("button", { name: "Open in Window" }));
    expect(screen.getByRole("dialog", { name: "Value of payload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
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
