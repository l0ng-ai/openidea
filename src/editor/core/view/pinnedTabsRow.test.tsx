import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { useTabs } from "../controller";
import type { Tab } from "../model/tabs";
import { EditorAreaView } from "./EditorArea";

vi.mock("../controller", async (original) => ({
  ...(await original<object>()),
  editorController: () => ({ publishContext: vi.fn(), tabMenu: () => [] }),
}));
vi.mock("./TextEditorHost", () => ({ TextEditorHost: () => <input aria-label="Source" /> }));
vi.mock("./FindBar", () => ({ FindBar: () => null }));
vi.mock("./Banner", () => ({ EditorBanners: () => null, VirtualBanner: () => null }));
vi.mock("./StatusItems", () => ({ CodeBreadcrumbs: () => null }));

const tab = (n: number, pinned: boolean): Tab => ({
  id: `t${n}`,
  input: { kind: "file", key: `/p/f${n}.txt`, path: `/p/f${n}.txt` },
  preview: false,
  pinned,
});
const originalTabs = useTabs.getState();
const originalProject = useProject.getState();

function seed(pinned: boolean[], tabs: Record<string, unknown>) {
  const list = pinned.map((p, i) => tab(i + 1, p));
  useTabs.setState({
    layout: { kind: "pane", paneId: "p1" },
    panes: { p1: { id: "p1", tabs: list, active: list[0]!.id, mru: list.map((t) => t.id) } },
    activePane: "p1",
    closed: [],
  });
  useProject.setState({ settings: { editor: { tabs } } as never });
}

beforeEach(() => cleanup());
afterEach(() => {
  cleanup();
  useTabs.setState(originalTabs, true);
  useProject.setState(originalProject, true);
});

describe("pinned tabs in a separate row", () => {
  it.each([
    { placement: "top", multipleRows: true, pinnedSeparateRow: true, rows: 2 },
    { placement: "bottom", multipleRows: true, pinnedSeparateRow: true, rows: 2 },
    { placement: "top", multipleRows: false, pinnedSeparateRow: true, rows: 2 },
    { placement: "left", multipleRows: false, pinnedSeparateRow: true, rows: 2 },
    { placement: "top", multipleRows: true, pinnedSeparateRow: false, rows: 1 },
    { placement: "top", multipleRows: false, pinnedSeparateRow: false, rows: 1 },
  ])("$placement multipleRows=$multipleRows pinnedRow=$pinnedSeparateRow → $rows strip(s)", (c) => {
    const { rows, ...tabs } = c;
    seed([true, true, false, false, false], tabs);
    render(<EditorAreaView />);
    const lists = screen.getAllByRole("tablist", { name: "Editor tabs" });
    expect(lists).toHaveLength(rows);
    if (rows === 2) {
      expect(within(lists[0]!).getAllByRole("tab")).toHaveLength(2);
      expect(within(lists[1]!).getAllByRole("tab")).toHaveLength(3);
    }
  });

  it.each([
    ["every tab pinned", [true, true, true]],
    ["no tab pinned", [false, false, false]],
  ])("%s → one strip", (_, pinned) => {
    seed(pinned, { placement: "top", multipleRows: true, pinnedSeparateRow: true });
    render(<EditorAreaView />);
    expect(screen.getAllByRole("tablist", { name: "Editor tabs" })).toHaveLength(1);
  });
});
