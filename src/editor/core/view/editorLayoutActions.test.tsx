import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerTextEditorWrapper } from "@/workbench/contributions";
import { useDistractionFree } from "@/workbench/distractionFree";
import { MarkdownEditor } from "@/features/viewers/markdown/MarkdownEditor";
import { MarkdownLayoutActions } from "@/features/viewers/markdown/MarkdownLayoutActions";
import { setMarkdownMode, useMarkdownModes } from "@/features/viewers/markdown/modes";
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

const md = (id: string, path: string): Tab => ({
  id,
  input: { kind: "file", key: path, path },
  preview: false,
  pinned: false,
});
const first = md("t1", "/p/first.md");
const second = md("t2", "/p/second.md");
let disposers: Array<() => void> = [];
const originalTabs = useTabs.getState();
const originalProject = useProject.getState();

beforeEach(() => {
  useMarkdownModes.setState({ byPath: {}, fallback: "editor" });
  useTabs.setState({
    layout: { kind: "pane", paneId: "p1" },
    panes: { p1: { id: "p1", tabs: [first], active: first.id, mru: [first.id] } },
    activePane: "p1",
    closed: [],
  });
  disposers = [
    registerTextEditorWrapper({
      id: "test.markdown",
      matches: (path) => path.endsWith(".md"),
      component: MarkdownEditor,
      tabActions: MarkdownLayoutActions,
    }),
    registerActions([
      { id: "markdown.editorOnly", title: "Editor Only", run: ({ arg }) => setMarkdownMode(String(arg), "editor") },
      {
        id: "markdown.editorAndPreview",
        title: "Editor and Preview",
        run: ({ arg }) => setMarkdownMode(String(arg), "split"),
      },
      { id: "markdown.previewOnly", title: "Preview Only", run: ({ arg }) => setMarkdownMode(String(arg), "preview") },
    ]),
  ];
});
afterEach(() => {
  cleanup();
  disposers.reverse().forEach((dispose) => dispose());
  useTabs.setState(originalTabs, true);
  useProject.setState(originalProject, true);
  useDistractionFree.setState({ active: false });
});

describe("Markdown layout controls", () => {
  it.each(["top", "bottom", "left", "right"])("uses the tab strip with %s tabs", (placement) => {
    useProject.setState({ settings: { editor: { tabs: { placement } } } as never });
    render(<EditorAreaView />);
    const toolbar = screen.getByRole("toolbar", { name: "Markdown editor layout" });
    expect(toolbar.closest('[role="tabpanel"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview Only" }));
    expect(screen.getByRole("document", { name: "Markdown preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Source" })).toBeInTheDocument();
  });

  it.each(["hidden", "distraction-free"])("uses one floating fallback when tabs are %s", (reason) => {
    useProject.setState({
      settings: { editor: { tabs: { placement: reason === "hidden" ? "none" : "top" } } } as never,
    });
    useDistractionFree.setState({ active: reason === "distraction-free" });
    render(<EditorAreaView />);
    expect(screen.getByRole("toolbar", { name: "Markdown editor layout" }).closest('[role="tabpanel"]')).not.toBeNull();
  });

  it("routes each pane's layout buttons to that pane's file", () => {
    useProject.setState({ settings: null });
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
        p1: { id: "p1", tabs: [first], active: first.id, mru: [first.id] },
        p2: { id: "p2", tabs: [second], active: second.id, mru: [second.id] },
      },
    });
    render(<EditorAreaView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Preview Only" })[1]!);
    expect(useMarkdownModes.getState().byPath[first.input.path!]).toBeUndefined();
    expect(useMarkdownModes.getState().byPath[second.input.path!]).toBe("preview");
    act(() => useDistractionFree.setState({ active: true }));
    expect(screen.getAllByRole("toolbar", { name: "Markdown editor layout" })).toHaveLength(2);
  });
});
