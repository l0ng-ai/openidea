import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { hideContextMenu, useContextMenuStore } from "@/ui";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

let open: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  useProject.setState({ settings: null });
  window.getSelection()?.removeAllRanges();
  open = vi.spyOn(window, "open").mockImplementation(() => null);
});
afterEach(() => {
  act(hideContextMenu);
  open.mockRestore();
});

function setup(text: string) {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  model.flush();
  render(<ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />);
  return screen.getByRole("log");
}

/** Selects the text of output rows `from`..`to` (inclusive). */
function selectRows(log: HTMLElement, from: number, to: number) {
  const rows = log.querySelectorAll("[data-index]");
  const range = document.createRange();
  range.setStart(rows[from]!, 0);
  range.setEnd(rows[to]!, rows[to]!.childNodes.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

function searchItem(log: HTMLElement) {
  fireEvent.contextMenu(log.querySelector("[data-index]")!);
  const items = useContextMenuStore.getState().menu?.items ?? [];
  return items.find((i) => "label" in i && i.label === "Search with Google") as
    | { disabled?: boolean; run?: () => void }
    | undefined;
}

it("is offered but disabled without a selection", () => {
  const log = setup("panic: runtime error\n");
  const item = searchItem(log);
  expect(item).toBeDefined();
  expect(item!.disabled).toBe(true);
});

it("stays disabled when only whitespace is selected", () => {
  const log = setup("first\n   \nsecond\n");
  selectRows(log, 1, 1);
  expect(window.getSelection()!.toString().trim()).toBe("");
  expect(searchItem(log)!.disabled).toBe(true);
});

it("searches the web for the selected output, trimmed and URL-encoded", () => {
  const log = setup("ok\n  Error: ENOENT & 50% #1 a+b?  \nok\n");
  selectRows(log, 1, 1);
  const item = searchItem(log)!;
  expect(item.disabled).toBe(false);
  act(() => item.run!());
  expect(open).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(
    "https://www.google.com/search?q=Error%3A%20ENOENT%20%26%2050%25%20%231%20a%2Bb%3F",
    "_blank",
    "noopener",
  );
});

it("keeps the line breaks of a multi-line selection in the query", () => {
  const log = setup("one\ntwo\nthree\n");
  selectRows(log, 0, 1);
  act(() => searchItem(log)!.run!());
  const url = new URL(open.mock.calls[0]![0] as string);
  expect(url.origin + url.pathname).toBe("https://www.google.com/search");
  expect(url.searchParams.get("q")).toBe(window.getSelection()!.toString().trim());
  expect(url.searchParams.get("q")).toMatch(/^one\n+two$/);
});

it("searches the whole buffer after Select All", () => {
  const log = setup("alpha\nbeta\n");
  fireEvent.keyDown(log, { key: "a", code: "KeyA", metaKey: true });
  act(() => searchItem(log)!.run!());
  expect(new URL(open.mock.calls[0]![0] as string).searchParams.get("q")).toBe("alpha\nbeta");
});
