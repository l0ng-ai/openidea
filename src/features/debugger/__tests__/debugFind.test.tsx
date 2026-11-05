import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMenuHost } from "@/ui";
import { usePlatform } from "@/platform/platformInfo";
import { adoptSession, appendConsole, useDebug } from "../state";
import { DebugConsole } from "../ui/DebugConsole";
import { DEFAULT_FIND_OPTIONS, findInConsole } from "../ui/consoleFind";

const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async () => {}) }));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 18, size: 18, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  useDebug.setState({ sessions: {}, console: {}, active: null });
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  window.getSelection()?.removeAllRanges();
});

function setup(text = "alpha beta\ngamma Beta\nbeta again\n") {
  const session = adoptSession(1);
  appendConsole(1, "stdout", text);
  const view = render(
    <>
      <DebugConsole session={session} />
      <ContextMenuHost />
      <div data-testid="outside">outside text</div>
    </>,
  );
  const log = screen.getByRole("log");
  return { session, log, view };
}

function openFind(log: HTMLElement) {
  fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
  return screen.getByRole("search");
}

function input() {
  return screen.getByRole("textbox", { name: "Find in console" });
}

function type(query: string) {
  fireEvent.change(input(), { target: { value: query } });
}

function markCount(container: HTMLElement) {
  return container.querySelectorAll("[data-find-match]").length;
}

describe("findInConsole", () => {
  const lines = [
    { id: 1, text: "alpha beta" },
    { id: 2, text: "gamma Beta" },
    { id: 3, text: "beta again" },
  ];

  it("matches every occurrence, ignoring case by default", () => {
    const result = findInConsole(lines, "beta", DEFAULT_FIND_OPTIONS);
    expect(result.matches.map((m) => [m.line, m.lineId, m.start, m.end])).toEqual([
      [0, 1, 6, 10],
      [1, 2, 6, 10],
      [2, 3, 0, 4],
    ]);
  });

  it("honours match case, whole words and regex", () => {
    expect(findInConsole(lines, "beta", { ...DEFAULT_FIND_OPTIONS, caseSensitive: true }).matches).toHaveLength(2);
    expect(findInConsole(lines, "bet", { ...DEFAULT_FIND_OPTIONS, wholeWord: true }).matches).toHaveLength(0);
    expect(findInConsole(lines, "b.ta", { ...DEFAULT_FIND_OPTIONS, regex: true }).matches).toHaveLength(3);
  });

  it("reports an invalid regular expression and an empty query", () => {
    expect(findInConsole(lines, "(", { ...DEFAULT_FIND_OPTIONS, regex: true }).invalid).toBe(true);
    expect(findInConsole(lines, "", DEFAULT_FIND_OPTIONS).matches).toEqual([]);
  });
});

describe("Debug console find", () => {
  it("opens on ⌘F, searches as you type and highlights every match", () => {
    const { log, view } = setup();
    expect(openFind(log)).toBeInTheDocument();
    expect(input()).toHaveFocus();

    type("beta");
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(markCount(view.container)).toBe(3);
    expect(view.container.querySelectorAll("[data-find-current]")).toHaveLength(1);
  });

  it("moves through matches with Enter / Shift+Enter and wraps around", () => {
    const { log } = setup();
    openFind(log);
    type("beta");
    const bar = screen.getByRole("search");
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByText("2/3")).toBeInTheDocument();
    fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/3")).toBeInTheDocument();
    fireEvent.keyDown(bar, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("supports match case and regex", () => {
    const { log, view } = setup();
    openFind(log);
    type("beta");
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Match Case" }));
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(markCount(view.container)).toBe(2);

    fireEvent.change(input(), { target: { value: "(" } });
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    expect(screen.getByText("Bad regex")).toBeInTheDocument();
  });

  it("closes on Escape, clears the highlights and returns focus to the console", () => {
    const { log, view } = setup();
    openFind(log);
    type("beta");
    expect(markCount(view.container)).toBe(3);

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(markCount(view.container)).toBe(0);
    expect(log).toHaveFocus();
  });

  it("offers the Run console's context menu", () => {
    const { log } = setup();
    fireEvent.contextMenu(log);
    for (const label of ["Copy", "Select All", "Copy All", "Find…", "Clear All"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Nothing is selected, so Copy has nothing to copy.
    expect(screen.getByText("Copy").closest("[aria-disabled]")).not.toBeNull();
    // Send EOF is the Run console's stdin; the debug console has no such input.
    expect(screen.queryByText("Send EOF")).not.toBeInTheDocument();
  });

  it("opens the find bar from the context menu", () => {
    const { log } = setup();
    fireEvent.contextMenu(log);
    fireEvent.click(screen.getByText("Find…"));
    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(input()).toHaveFocus();
  });

  it("copies the whole buffer without doubling the line breaks", async () => {
    // Console lines keep their trailing "\n", so joining them with one would add blank lines.
    const { log } = setup();
    fireEvent.contextMenu(log);
    fireEvent.click(screen.getByText("Copy All"));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("alpha beta\ngamma Beta\nbeta again\n"));
  });

  it("leaves Enter over a toggle button to the button, not to the next match", () => {
    const { log } = setup();
    openFind(log);
    type("beta");
    expect(screen.getByText("1/3")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Match Case" }), { key: "Enter" });
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("keeps the span's styling on a highlighted match", () => {
    const { log, view } = setup("\u001b[3mitalic beta\u001b[0m\n");
    openFind(log);
    type("beta");
    const mark = view.container.querySelector("[data-find-match]") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.style.fontStyle).toBe("italic");
  });

  it("keeps Copy disabled when the selection is outside the console", () => {
    const { log } = setup();
    const outside = screen.getByTestId("outside");
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    fireEvent.contextMenu(log);
    expect(screen.getByText("Copy").closest("[aria-disabled]")).not.toBeNull();
  });
});
