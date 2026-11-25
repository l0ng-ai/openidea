import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { hideContextMenu, useContextMenuStore } from "@/ui";
import { ConsoleModel } from "./console";
import { ConsoleView, foldLineText } from "./ConsoleView";

const actions = vi.hoisted(() => ({ executeAction: vi.fn(async () => {}) }));
vi.mock("@/platform/actions", async (orig) => ({ ...(await orig<object>()), executeAction: actions.executeAction }));

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
  actions.executeAction.mockClear();
  useProject.setState({ settings: null });
  window.getSelection()?.removeAllRanges();
});

afterEach(() => act(hideContextMenu));

function setup(chunks: { kind: "stdout" | "stderr" | "system"; text: string }[]) {
  const model = new ConsoleModel();
  for (const c of chunks) model.append(c);
  model.flush();
  const { container } = render(
    <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />,
  );
  return within(container).getByRole("log");
}

function foldItem(target: Element) {
  fireEvent.contextMenu(target);
  const items = useContextMenuStore.getState().menu?.items ?? [];
  return items.find((i) => "label" in i && i.label === "Fold Lines Like This") as
    | { disabled?: boolean; run?: () => void }
    | undefined;
}

function select(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

describe("foldLineText", () => {
  it("takes a one-line selection, else the clicked line, trimmed", () => {
    expect(foldLineText("  at org.junit.Assert ", "ignored")).toBe("at org.junit.Assert");
    expect(foldLineText("", "\tat java.base/Thread.run(Thread.java:1583)  ")).toBe(
      "at java.base/Thread.run(Thread.java:1583)",
    );
    // A whole row picked by a triple click ends in its line break.
    expect(foldLineText("DEBUG pool\n", null)).toBe("DEBUG pool");
  });

  it("has nothing for a selection across lines, a blank selection or a blank line", () => {
    expect(foldLineText("first\nsecond", "first")).toBeNull();
    expect(foldLineText("first\r\nsecond", "first")).toBeNull();
    expect(foldLineText("   ", "a line")).toBeNull();
    expect(foldLineText("", "   ")).toBeNull();
    expect(foldLineText("", null)).toBeNull();
  });
});

describe("Fold Lines Like This", () => {
  it("opens Settings › Console with the clicked line to add as a fold pattern", () => {
    const log = setup([
      {
        kind: "stdout",
        text: "start\n    at org.springframework.test.context.TestContextManager.prepare(TestContextManager.java:248)\n",
      },
    ]);
    const row = log.querySelectorAll("[data-index]")[1]!;
    const item = foldItem(row.firstElementChild ?? row)!;
    expect(item.disabled).toBeFalsy();
    item.run!();
    expect(actions.executeAction).toHaveBeenCalledWith(
      "file.settings",
      "build.console#at org.springframework.test.context.TestContextManager.prepare(TestContextManager.java:248)",
    );
  });

  it("uses the selected part of a line rather than the whole line", () => {
    const log = setup([{ kind: "stdout", text: "12:00 DEBUG pool: idle\n" }]);
    const row = log.querySelector("[data-index]")!;
    const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!;
    select(text, 6, 11);
    foldItem(row)!.run!();
    expect(actions.executeAction).toHaveBeenCalledWith("file.settings", "build.console#DEBUG");
  });

  it("is disabled for a selection over several lines", () => {
    const log = setup([{ kind: "stdout", text: "one\ntwo\n" }]);
    const rows = log.querySelectorAll("[data-index]");
    const range = document.createRange();
    range.setStart(rows[0]!, 0);
    range.setEnd(rows[1]!, rows[1]!.childNodes.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(foldItem(rows[0]!)!.disabled).toBe(true);
  });

  it("is disabled on a blank line, the IDE's own messages and a folded run", () => {
    useProject.setState({ settings: { console: { foldPatterns: ["at org."] } } as never });
    const log = setup([
      { kind: "stdout", text: "\n" },
      { kind: "system", text: "Process finished with exit code 0\n" },
    ]);
    const rows = log.querySelectorAll("[data-index]");
    expect(foldItem(rows[0]!)!.disabled).toBe(true);
    expect(foldItem(rows[1]!)!.disabled).toBe(true);
    act(hideContextMenu);

    const folded = setup([{ kind: "stdout", text: "at org.a\nat org.b\n" }]);
    const fold = folded.querySelector("[data-index]")!;
    expect(fold.textContent).toContain("internal lines");
    expect(foldItem(fold)!.disabled).toBe(true);
    expect(actions.executeAction).not.toHaveBeenCalled();
  });
});
