import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
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

beforeEach(() => useProject.setState({ settings: null }));
afterEach(() => act(hideContextMenu));

function pauseItem(log: Element) {
  fireEvent.contextMenu(log);
  const items = useContextMenuStore.getState().menu?.items ?? [];
  return items.find((i) => "label" in i && i.label === "Pause Output") as
    | { checked?: boolean; run?: () => void }
    | undefined;
}

it("Pause Output keeps the output on screen until it is resumed, then shows what arrived meanwhile", () => {
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text: "first\nsecond " });
  const view = (version: number) => (
    <ConsoleView model={model} version={version} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />
  );
  const { container, rerender } = render(view(1));
  const log = within(container).getByRole("log");
  expect(pauseItem(log)?.checked).toBe(false);
  act(() => pauseItem(log)!.run!());

  // The open line and new lines keep arriving while paused, but are not shown.
  model.append({ kind: "stdout", text: "half\nthird\n" });
  rerender(view(2));
  expect(log.textContent).toContain("first");
  expect(log.textContent).toContain("second");
  expect(log.textContent).not.toContain("half");
  expect(log.textContent).not.toContain("third");
  expect(pauseItem(log)?.checked).toBe(true);

  act(() => pauseItem(log)!.run!());
  expect(log.textContent).toContain("second half");
  expect(log.textContent).toContain("third");
});
