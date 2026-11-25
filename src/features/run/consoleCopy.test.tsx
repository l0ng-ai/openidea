import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  window.getSelection()?.removeAllRanges();
});

function setup(text: string, softWrap = false) {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  model.flush();
  const view = render(
    <ConsoleView model={model} version={1} softWrap={softWrap} follow={false} onFollowChange={() => {}} cwd="/" />,
  );
  return { model, log: screen.getByRole("log"), view };
}

/** The text a Select All + Copy takes: every mounted row, in order. */
function selectedText(log: HTMLElement) {
  const inner = log.firstElementChild!;
  const range = document.createRange();
  range.selectNodeContents(inner);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}

describe("Copying run output", () => {
  it("takes blank lines from the buffer, adding no zero-width space", () => {
    const { model, log } = setup("first\n\nsecond\n");
    expect(model.text()).toBe("first\n\nsecond");
    // A blank line is one empty row: it may only contribute its own line break.
    expect(selectedText(log).split("\n")).toEqual(["first", "", "second", ""]);
    expect(log.textContent).not.toContain("\u200b");
  });

  it("keeps the zero-width space out of soft-wrapped output too", () => {
    const { log } = setup("first\n\nsecond\n", true);
    expect(selectedText(log).split("\n")).toEqual(["first", "", "second", ""]);
    expect(log.textContent).not.toContain("\u200b");
  });

  it("still renders a row for every line, blank ones included", () => {
    const { model, log } = setup("first\n\n\nsecond\n");
    expect(model.lines).toHaveLength(4);
    expect(log.querySelectorAll("[data-index]")).toHaveLength(model.lines.length);
    expect(log.textContent?.replace(/\n/g, "")).toBe("first" + "second");
  });

  it("puts the same text on the clipboard when a selection is copied with ⌘C", async () => {
    const { log } = setup("first\n\nsecond\n");
    // A selection of the rows, not Select All: that path copies the model and would hide a character
    // the DOM adds.
    const rows = log.querySelectorAll("[data-index]");
    const range = document.createRange();
    range.setStart(rows[0]!, 0);
    range.setEnd(rows[2]!, rows[2]!.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.keyDown(log, { key: "c", code: "KeyC", metaKey: true });
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    // Three rows, each ending in its own break: the blank one contributes nothing else.
    expect(clipboard.writeText.mock.calls[0]![0]).toBe("first\n\nsecond\n");
  });
});
