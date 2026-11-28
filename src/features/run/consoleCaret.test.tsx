import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlatform } from "@/platform/platformInfo";
import { caretFromDom } from "@/ui/consoleCaret";
import { ConsoleModel } from "./console";
import { ConsoleView, foldRows, selectionText, type ConsoleInput } from "./ConsoleView";

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));
const scrolled = vi.hoisted(() => [] as number[]);

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 20, size: 20, key: index })),
    scrollToIndex: (index: number) => scrolled.push(index),
    scrollToOffset: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => {
  usePlatform.setState({ os: "linux" });
  clipboard.writeText.mockClear();
  scrolled.length = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  window.getSelection()?.removeAllRanges();
});

function setup(text: string, options: { follow?: boolean; input?: ConsoleInput } = {}) {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  model.flush();
  const follows: boolean[] = [];
  function Console() {
    const [follow, setFollow] = useState(options.follow ?? false);
    return (
      <ConsoleView
        model={model}
        version={1}
        softWrap={false}
        follow={follow}
        onFollowChange={(next) => {
          follows.push(next);
          setFollow(next);
        }}
        cwd="/"
        input={options.input}
      />
    );
  }
  render(<Console />);
  const log = screen.getByRole("log");
  const row = (index: number) => log.querySelector<HTMLElement>(`[data-index="${index}"]`)!;
  /** Clicks into a row's text, as the browser leaves a collapsed selection there. */
  const click = (index: number, offset: number) =>
    act(() => {
      const text = row(index).querySelector("span")!.firstChild!;
      window.getSelection()!.collapse(text, offset);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const press = (key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) =>
    act(() => {
      fireEvent.keyDown(log, { key, ...mods });
    });
  const caret = () => {
    const s = window.getSelection()!;
    return {
      focus: caretFromDom(log, s.focusNode, s.focusOffset),
      anchor: caretFromDom(log, s.anchorNode, s.anchorOffset),
    };
  };
  return { model, log, click, press, caret, follows };
}

const OUTPUT = "first line\nsecond\n\nfourth line here\nlast";

describe("the Run console's caret", () => {
  it("puts Home / End on the line's start / end instead of scrolling the output", () => {
    const { click, press, caret } = setup(OUTPUT);
    click(1, 2);
    press("End");
    expect(caret().focus).toEqual({ row: 1, offset: 6 });
    press("Home");
    expect(caret().focus).toEqual({ row: 1, offset: 0 });
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it("goes to the start / end of the output with Ctrl+Home / Ctrl+End, following it at the end", () => {
    const { click, press, caret, follows } = setup(OUTPUT);
    click(1, 2);
    press("End", { ctrlKey: true });
    expect(caret().focus).toEqual({ row: 4, offset: 4 });
    expect(follows.at(-1)).toBe(true);
    press("Home", { ctrlKey: true });
    expect(caret().focus).toEqual({ row: 0, offset: 0 });
    expect(follows.at(-1)).toBe(false);
  });

  it("stops following when the caret leaves the end of the output", () => {
    const { press, caret, follows } = setup(OUTPUT, { follow: true });
    // No caret yet in followed output: it starts at the end.
    press("ArrowUp");
    expect(caret().focus).toEqual({ row: 3, offset: 4 });
    expect(follows).toEqual([false]);
  });

  it("moves through lines keeping the column, and a page with PageUp / PageDown", () => {
    const { click, press, caret } = setup(OUTPUT);
    click(0, 8);
    press("ArrowDown");
    expect(caret().focus).toEqual({ row: 1, offset: 6 });
    press("ArrowDown");
    expect(caret().focus).toEqual({ row: 2, offset: 0 });
    press("ArrowDown");
    expect(caret().focus).toEqual({ row: 3, offset: 8 });
    press("ArrowLeft");
    press("ArrowRight");
    press("ArrowRight");
    expect(caret().focus).toEqual({ row: 3, offset: 9 });
    // The whole output fits in a page: PageUp / PageDown stop at its first / last line, in the column.
    press("PageUp");
    expect(caret().focus).toEqual({ row: 0, offset: 9 });
    press("PageDown");
    expect(caret().focus).toEqual({ row: 4, offset: 4 });
  });

  it("extends the selection with Shift and copies the selected output", async () => {
    const { log, click, press, caret } = setup(OUTPUT);
    click(0, 6);
    press("ArrowDown", { shiftKey: true });
    press("End", { shiftKey: true });
    expect(caret()).toEqual({ anchor: { row: 0, offset: 6 }, focus: { row: 1, offset: 6 } });
    const dom = window.getSelection()!.toString();
    expect(dom).toBe("line\nsecond");
    fireEvent.keyDown(log, { key: "c", code: "KeyC", ctrlKey: true });
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(clipboard.writeText.mock.calls[0]![0]).toBe(dom);
    press("Home", { ctrlKey: true, shiftKey: true });
    expect(caret()).toEqual({ anchor: { row: 0, offset: 6 }, focus: { row: 0, offset: 0 } });
  });

  it("draws one caret: typed input takes it back to the end", () => {
    const input: ConsoleInput = { pending: "", onChange: vi.fn(), onSubmit: vi.fn(), onEof: vi.fn() };
    const { log, click, press } = setup("prompt> ", { input });
    click(0, 2);
    press("End");
    const drawn = log.firstElementChild!.firstElementChild as HTMLElement;
    expect(drawn.hidden).toBe(false);
    press("x");
    expect(input.onChange).toHaveBeenCalledWith("x");
    expect(window.getSelection()!.rangeCount).toBe(0);
    expect(drawn.hidden).toBe(true);
  });
});

describe("text of a caret selection", () => {
  it("joins lines as the model does, keeps cut lines whole and includes folded lines", () => {
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: "keep 1\nskip a\nskip b\nkeep 2\n" });
    model.flush();
    const rows = foldRows(model.lines, ["skip"], new Set());
    // Row 0 carries the fold of lines 1–2; row 1 is "keep 2".
    expect(rows).toHaveLength(2);
    expect(selectionText(model.lines, rows, { row: 1, offset: 4 }, { row: 0, offset: 2 })).toBe(
      "ep 1\nskip a\nskip b\nkeep",
    );
    const cut = [
      { ...model.lines[0]!, continues: true },
      { ...model.lines[3]!, id: 99 },
    ];
    expect(selectionText(cut, foldRows(cut, [], new Set()), { row: 0, offset: 5 }, { row: 1, offset: 2 })).toBe("1ke");
  });
});
