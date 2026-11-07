import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { notifyTabTitlesChanged, registerEditorKind } from "@/workbench/contributions";
import { useTabs } from "../controller";
import type { Tab } from "../model/tabs";
import { EditorAreaView } from "./EditorArea";

vi.mock("../controller", async (original) => ({
  ...(await original<object>()),
  editorController: () => ({ publishContext: vi.fn(), tabMenu: () => [] }),
}));
vi.mock("./TextEditorHost", () => ({ TextEditorHost: () => null }));
vi.mock("./FindBar", () => ({ FindBar: () => null }));
vi.mock("./Banner", () => ({ EditorBanners: () => null, VirtualBanner: () => null }));
vi.mock("./StatusItems", () => ({ CodeBreadcrumbs: () => null }));

/** The title a kind reports; changed behind the tab strip's back, like a renamed task. */
let title = "Alpha";
const disposer = registerEditorKind({
  kind: "renamable",
  component: () => null,
  title: () => title,
  document: {
    isDirty: () => true,
    flush: async () => {},
    save: async () => {},
    prepareClose: async () => {},
    cancelClose: () => {},
    discard: async () => {},
    close: async () => {},
  },
});

const tab: Tab = { id: "t1", input: { kind: "renamable", key: "k" }, preview: false, pinned: false };
const original = useTabs.getState();

function show() {
  act(() =>
    useTabs.setState({
      layout: { kind: "pane", paneId: "p1" },
      panes: { p1: { id: "p1", tabs: [tab], active: tab.id, mru: [tab.id] } },
      activePane: "p1",
      closed: [],
    }),
  );
}

const label = () => screen.getByRole("tab").textContent ?? "";

afterEach(() => {
  cleanup();
  useTabs.setState(original, true);
  title = "Alpha";
});
afterAll(() => disposer());

describe("editor tab titles", () => {
  it("recomputes a kind's title when the tab-title revision is bumped", () => {
    show();
    render(<EditorAreaView />);
    expect(label()).toContain("Alpha");

    // The task was renamed: the kind reports the new title, and the store says so.
    title = "Beta";
    act(() => notifyTabTitlesChanged());

    expect(label()).toContain("Beta");
  });

  it("leaves unrelated tab state alone", () => {
    show();
    render(<EditorAreaView />);
    const modified = screen.getAllByLabelText("Modified");
    const state = useTabs.getState();
    title = "Beta";
    act(() => notifyTabTitlesChanged());
    expect(useTabs.getState()).toBe(state);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(label()).not.toContain("Alpha");
    expect(screen.getAllByLabelText("Modified")).toEqual(modified);
  });

  it("refreshes the same input in every split pane", () => {
    show();
    act(() =>
      useTabs.setState({
        layout: {
          kind: "split",
          id: "split",
          dir: "row",
          children: [
            { kind: "pane", paneId: "p1" },
            { kind: "pane", paneId: "p2" },
          ],
        },
        panes: {
          ...useTabs.getState().panes,
          p2: { id: "p2", tabs: [tab], active: tab.id, mru: [tab.id] },
        },
      }),
    );
    render(<EditorAreaView />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    title = "Beta";
    act(() => notifyTabTitlesChanged());
    expect(screen.getAllByRole("tab").every((el) => el.textContent?.includes("Beta"))).toBe(true);
  });
});
