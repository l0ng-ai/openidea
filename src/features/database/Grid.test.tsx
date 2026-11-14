import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { registerActions } from "@/platform/actions";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ContextMenuHost } from "@/ui";
import { within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { DataView } from "./DataView";
import { Grid } from "./Grid";
import { CELL_PREVIEW_LIMIT, cellPreview } from "./cellPreview";
import { exportData } from "./export";
import { installCellActions } from "./cellActions";

let disposeCellActions: () => void;
beforeEach(() => {
  useKeymap.setState({ preset: "intellij-macos", overrides: {} });
  const disposeActions = installCellActions();
  const disposeKeys = installKeyboardDispatcher();
  disposeCellActions = () => {
    disposeKeys();
    disposeActions();
  };
});
afterEach(() => disposeCellActions());

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

  it("opens SQL NULL without an error or a redundant pending edit", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => null} editable onEdit={onEdit} />);
    openWindow();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set NULL" }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps an edited inline draft when maximizing and applies it unchanged", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={onEdit} />);
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    const input = screen.getByRole("textbox");
    const draft = '{"name": "Grace", "n":9007199254740993}';
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(view().state.doc.toString()).toBe(draft);
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, draft);
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

  it("allows plain text after JSON highlighting was inferred from text content", () => {
    const onEdit = vi.fn();
    render(
      <Grid columns={[{ name: "payload", type: "text" }]} rowCount={1} value={() => json} editable onEdit={onEdit} />,
    );
    openWindow();
    editDoc("plain text now");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, "plain text now");
  });

  it("keeps the compact value unchanged after opening, applying and closing", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={onEdit} />);
    openWindow();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEdit).not.toHaveBeenCalled();
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

  it("carries the panel draft into the window and keeps typed text on Apply", () => {
    const onEdit = vi.fn();
    render(
      <DataView
        columns={payload}
        rowCount={1}
        value={() => json}
        panel="value"
        onPanelChange={() => {}}
        editable
        onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
    const draft = '{"name": "Grace", "n": 9007199254740993}';
    editDoc(draft);
    fireEvent.click(screen.getByRole("button", { name: "Open in Window" }));
    const dialog = screen.getByRole("dialog");
    const content = dialog.querySelector<HTMLElement>(".cm-content")!;
    expect(EditorView.findFromDOM(content)!.state.doc.toString()).toBe(draft);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, draft);
  });

  it("does not reformat or apply a read-only Value panel", () => {
    const onEdit = vi.fn();
    render(
      <DataView
        columns={payload}
        rowCount={1}
        value={() => json}
        panel="value"
        onPanelChange={() => {}}
        onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
    expect((screen.getByRole("button", { name: "Reformat" }) as HTMLButtonElement).disabled).toBe(true);
    const v = view();
    act(() => v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in Window" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("treats blank text as invalid for typed JSON and restores the unchanged state when the original text is restored", () => {
    const onEdit = vi.fn();
    render(<Grid columns={payload} rowCount={1} value={() => json} editable onEdit={onEdit} />);
    openWindow();
    editDoc("");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    editDoc(pretty);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
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
    fireEvent.keyDown(screen.getByRole("grid"), { key: " ", code: "Space" });
    expect(onEdit).toHaveBeenCalledWith(0, 0, "t");
    fireEvent.mouseDown(screen.getAllByRole("gridcell")[2]!, { button: 0 });
    fireEvent.keyDown(screen.getByRole("grid"), { key: " ", code: "Space" });
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
    const select = screen.getByRole("listbox", { name: "Edit ok" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["true", "false", "NULL"]);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("gridcell"));
    fireEvent.click(screen.getByRole("option", { name: "NULL" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, null);
    expect(screen.queryByRole("listbox")).toBeNull();
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
    const select = screen.getByRole("listbox", { name: "Edit ok" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["true", "false"]);
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
    const select = screen.getByRole("listbox", { name: "Edit mood" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["sad", "ok", "happy", "NULL"]);
    expect(screen.getByRole("option", { name: "sad" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "happy" }));
    expect(onEdit).toHaveBeenCalledWith(0, 0, "happy");
    expect(screen.queryByRole("listbox")).toBeNull();
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
    const select = screen.getByRole("listbox", { name: "Edit mood" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["moody", "calm", "angry", "NULL"]);
    expect(screen.getByRole("option", { name: "moody" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(select, { key: "Escape" });
    expect(onEdit).not.toHaveBeenCalled();
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
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", metaKey: true });
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
    const onResetCell = vi.fn();
    render(
      <>
        <Grid
          columns={columns}
          rowCount={2}
          value={() => "old"}
          editable
          onEdit={onEdit}
          rowState={(r) => (r === 1 ? "inserted" : null)}
          onResetCell={onResetCell}
        />
        <ContextMenuHost />
      </>,
    );
    const cells = screen.getAllByRole("gridcell");
    // Row 1 is an added row: its cells drop their value so the DB default applies.
    fireEvent.mouseDown(cells[4]!, { button: 0 }); // row 1, column b (no default of its own)
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", metaKey: true, shiftKey: true });
    expect(onResetCell).toHaveBeenCalledWith(1, 1);
    expect(onEdit).not.toHaveBeenCalled();

    // Row 0: column a's default is a literal; column c's is an expression and stays.
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.contextMenu(screen.getByRole("grid"), { clientX: 5, clientY: 5 });
    await act(async () => void fireEvent.click(screen.getByRole("menuitem", { name: /Set DEFAULT/ })));
    expect(onEdit).toHaveBeenCalledWith(0, 0, "x");
    expect(onEdit).toHaveBeenCalledTimes(1);
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

describe("cell action routing", () => {
  it.each(["intellij-macos", "vscode-macos", "intellij-windows"] as const)(
    "uses %s bindings and leaves text editing alone",
    (preset) => {
      useKeymap.setState({ preset, overrides: {} });
      const onEdit = vi.fn();
      render(
        <Grid
          columns={[{ name: "text", type: "text", default: "'reset'" }]}
          rowCount={1}
          value={() => "words"}
          editable
          onEdit={onEdit}
        />,
      );
      const cell = screen.getByRole("gridcell");
      fireEvent.mouseDown(cell, { button: 0 });
      const modifiers = preset === "intellij-windows" ? { ctrlKey: true } : { metaKey: true };
      fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", ...modifiers });
      expect(onEdit).toHaveBeenLastCalledWith(0, 0, null);
      fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", shiftKey: true, ...modifiers });
      expect(onEdit).toHaveBeenLastCalledWith(0, 0, "reset");
      onEdit.mockClear();
      fireEvent.doubleClick(cell);
      const input = screen.getByRole("textbox");
      expect(fireEvent.keyDown(input, { key: "Backspace", ...modifiers })).toBe(true);
      expect(fireEvent.keyDown(input, { key: " ", code: "Space" })).toBe(true);
      expect(onEdit).not.toHaveBeenCalled();
    },
  );

  it("disables DEFAULT for a mixed literal/expression range without partially applying it", () => {
    const onEdit = vi.fn();
    render(
      <>
        <Grid
          columns={[
            { name: "a", type: "text", default: "'x'" },
            { name: "b", type: "text", default: "now()" },
          ]}
          rowCount={1}
          value={() => "old"}
          editable
          onEdit={onEdit}
        />
        <ContextMenuHost />
      </>,
    );
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[0]!, { button: 0 });
    fireEvent.mouseEnter(cells[1]!);
    fireEvent.mouseUp(window);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", metaKey: true, shiftKey: true });
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByRole("grid"));
    expect(screen.getByRole("menuitem", { name: /Set DEFAULT/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("refreshes boolean metadata when columns arrive with unchanged names", () => {
    const onEdit = vi.fn();
    const props = { rowCount: 1, value: () => "0", editable: true, onEdit, driver: "sqlite" as const };
    const { rerender } = render(<Grid {...props} columns={[{ name: "enabled", type: "unknown" }]} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(<Grid {...props} columns={[{ name: "enabled", type: "boolean" }]} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onEdit).toHaveBeenCalledWith(0, 0, "1");
  });
});

it.each([
  ["postgres", "boolean", "t", "f"],
  ["sqlite", "boolean", "1", "0"],
  ["mysql", "tinyint(1)", "1", "0"],
  ["sqlServer", "bit", "true", "false"],
] as const)("toggles and resets %s booleans using its rendered literals", (driver, type, t, f) => {
  const onEdit = vi.fn();
  render(
    <Grid
      columns={[{ name: "enabled", type, default: "((1))" }]}
      rowCount={1}
      value={() => f}
      editable
      onEdit={onEdit}
      driver={driver}
    />,
  );
  fireEvent.mouseDown(screen.getByRole("gridcell"), { button: 0 });
  fireEvent.keyDown(screen.getByRole("grid"), { key: " ", code: "Space" });
  expect(onEdit).toHaveBeenLastCalledWith(0, 0, t);
  fireEvent.keyDown(screen.getByRole("grid"), { key: "Backspace", metaKey: true, shiftKey: true });
  expect(onEdit).toHaveBeenLastCalledWith(0, 0, t);
});

it.each(["Escape", "Enter"])("%s closes the inline text editor without a second blur commit", (key) => {
  const onEdit = vi.fn();
  render(
    <Grid columns={[{ name: "state", type: "text" }]} rowCount={1} value={() => "old"} editable onEdit={onEdit} />,
  );
  fireEvent.doubleClick(screen.getByRole("gridcell"));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "changed" } });
  fireEvent.keyDown(input, { key });
  expect(screen.queryByRole("textbox")).toBeNull();
  if (key === "Escape") expect(onEdit).not.toHaveBeenCalled();
  else expect(onEdit).toHaveBeenCalledExactlyOnceWith(0, 0, "changed");
});
