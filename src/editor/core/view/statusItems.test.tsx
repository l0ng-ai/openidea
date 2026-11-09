import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { OutlineItem, Settings } from "@/platform/ipc";
import type { EditorStatus } from "../controller";

vi.mock("../controller", async () => {
  const { create } = await import("zustand");
  return {
    editorController: () => ({ openFile: vi.fn(), slots: new Map() }),
    useEditorStatus: create<{ status: EditorStatus | null }>(() => ({ status: null })),
    useGotoLine: create(() => ({ open: false })),
    useTabs: create(() => ({ panes: {}, activePane: "" })),
    isTextInput: (input: { kind: string }) => input.kind === "file" || input.kind === "virtual",
  };
});

const { useEditorStatus, useTabs } = await import("../controller");
const { useOutline } = await import("../model/document");
const { useProject } = await import("@/platform/project");
const { clearProjectViewLead, setProjectViewLead } = await import("@/workbench/contributions");
const { Breadcrumbs, CodeBreadcrumbs } = await import("./StatusItems");
const { NavBarPopup, openNavBarPopup, useNavBarPopup } = await import("./NavBarPopup");

const PATH = "/p/Orders.ts";
const span = (from: number, to: number) => ({ start: { line: from, col: 0 }, end: { line: to, col: 0 } });
const item = (name: string, from: number, to: number, children: OutlineItem[] = []): OutlineItem =>
  ({
    name,
    detail: null,
    kind: "method",
    range: span(from, to),
    selection_range: span(from, from),
    children,
  }) as OutlineItem;

const caret = (line: number, col: number): EditorStatus => ({
  path: PATH,
  doc: 1,
  line,
  col,
  offset: line * 80 + col,
  selectedChars: 0,
  selectedLines: 0,
  carets: 1,
});

describe("caret-driven status widgets", () => {
  it("re-render when the symbol at the caret changes, not on every caret move", () => {
    useProject.setState({
      project: {
        root: "/workspace",
        name: "Workspace",
        settings: { appearance: { navigationBar: "top" } },
        trusted: true,
        isGit: false,
        workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
      },
      settings: { appearance: { navigationBar: "top" } } as unknown as Settings,
    });
    useOutline.setState({ [PATH]: [item("Orders", 0, 40, [item("place", 2, 10), item("cancel", 12, 20)])] });
    act(() => useEditorStatus.setState({ status: caret(3, 4) }));
    let commits = 0;
    const count = () => void commits++;
    render(
      <>
        <Profiler id="breadcrumbs" onRender={count}>
          <Breadcrumbs />
        </Profiler>
        <Profiler id="code" onRender={count}>
          <CodeBreadcrumbs path={PATH} tabId="t1" position="bottom" />
        </Profiler>
        <Profiler id="navbar" onRender={count}>
          <NavBarPopup />
        </Profiler>
      </>,
    );
    expect(screen.getAllByText("place")).toHaveLength(2);
    commits = 0;

    // Typing inside `place`: line and column move, the chain does not.
    for (let col = 5; col < 25; col++) act(() => useEditorStatus.setState({ status: caret(4, col) }));
    expect(commits).toBe(0);

    // Into `cancel`: both breadcrumbs follow.
    act(() => useEditorStatus.setState({ status: caret(14, 0) }));
    expect(screen.getAllByText("cancel")).toHaveLength(2);
    expect(screen.queryByText("place")).toBeNull();
    expect(commits).toBeGreaterThan(0);
  });

  it("follows the caret into a Vue component's <script> declarations", () => {
    useOutline.setState({
      [PATH]: [item("template", 0, 4), { ...item("script", 5, 30), children: [item("size", 10, 20)] }],
    });
    act(() => useEditorStatus.setState({ status: caret(12, 2) }));
    render(<Breadcrumbs />);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent!;
    expect(crumbs).toContain("script");
    expect(crumbs).toContain("size");
  });
});

it("shows the member and its directories in workspace breadcrumbs", async () => {
  // No `navigationBar` key: the status bar is the default placement.
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: {},
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
    settings: {} as unknown as Settings,
  });
  useEditorStatus.setState({ status: { ...caret(0, 0), path: "/b/src/file.ts" } });
  const view = render(<Breadcrumbs inStatusBar />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("bsrcfile.ts");
  view.unmount();
  useProject.setState({ project: null });
});

it("keeps the top bar on the project node when no editor is active", async () => {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: { appearance: { navigationBar: "top" } },
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
    settings: { appearance: { navigationBar: "top" } } as unknown as Settings,
  });
  // Switching tabs clears the active editor's status for a frame.
  useEditorStatus.setState({ status: null });
  const view = render(<Breadcrumbs className="nav" />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("Workspace");
  view.unmount();
  // The footer instance stays empty: the status bar itself reserves the row.
  useProject.setState({ settings: {} as unknown as Settings });
  const footer = render(<Breadcrumbs inStatusBar />);
  expect(screen.queryByRole("navigation", { name: "Breadcrumbs" })).toBeNull();
  footer.unmount();
  useProject.setState({ project: null, settings: null });
});

it("shows the incoming tab's path while a tab switch is still loading", async () => {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: { appearance: { navigationBar: "top" } },
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
    settings: { appearance: { navigationBar: "top" } } as unknown as Settings,
  });
  // The tab is active, but its editor slot has not reported a status yet.
  useEditorStatus.setState({ status: { ...caret(0, 0), path: "/a/old.ts" } });
  useTabs.setState({
    activePane: "p1",
    panes: {
      p1: {
        id: "p1",
        tabs: [
          {
            id: "t1",
            input: { kind: "file", key: "file:/b/src/file.ts", path: "/b/src/file.ts" },
            preview: false,
            pinned: false,
          },
        ],
        active: "t1",
        mru: ["t1"],
      },
    },
  });
  const view = render(<Breadcrumbs className="nav" />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("bsrcfile.ts");
  const buttons = screen.getByRole("navigation", { name: "Breadcrumbs" }).querySelectorAll("button");
  buttons[0]!.focus();
  fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(buttons[1]);
  fireEvent.keyDown(buttons[1]!, { key: "End" });
  expect(document.activeElement).toBe(buttons[2]);
  view.unmount();
  useTabs.setState({ panes: {}, activePane: "" });
  useProject.setState({ project: null, settings: null });
});

it("follows the project view's folder until the editor takes over", async () => {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: { appearance: { navigationBar: "top" } },
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
    settings: { appearance: { navigationBar: "top" } } as unknown as Settings,
  });
  useEditorStatus.setState({ status: { ...caret(0, 0), path: "/b/src/file.ts" } });
  // The Project view holds the context: the bar shows its folder, not the editor's file.
  setProjectViewLead({ path: "/b/src/lib", dir: true });
  const view = render(<Breadcrumbs className="nav" />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("bsrclib");
  act(() => setProjectViewLead({ path: "/external/lib", dir: true }));
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("lib");
  view.unmount();
  // Focusing the editor or switching tabs hands the context back.
  clearProjectViewLead();
  const back = render(<Breadcrumbs className="nav" />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("bsrcfile.ts");
  back.unmount();
  useProject.setState({ project: null, settings: null });
});

it("opens the hidden navigation bar on the project when no editor is active", () => {
  useEditorStatus.setState({ status: null });
  clearProjectViewLead();
  useProject.setState({
    project: { root: "/p", name: "Project", settings: {}, trusted: true, isGit: false, workspace: null },
    settings: { appearance: { navigationBar: "hidden" } } as unknown as Settings,
  });
  openNavBarPopup();
  const view = render(<NavBarPopup />);
  expect(screen.getByRole("toolbar", { name: "Navigation bar" }).textContent).toBe("Project");
  expect(screen.getByRole("button", { name: "Project" }).getAttribute("aria-current")).toBe("location");
  view.unmount();
  useNavBarPopup.setState({ open: false });
  useProject.setState({ project: null, settings: null });
});

it("shows the project › dirs › file path above the editor", async () => {
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: { appearance: { navigationBar: "top" } },
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
    settings: { appearance: { navigationBar: "top" } } as unknown as Settings,
  });
  useEditorStatus.setState({ status: { ...caret(0, 0), path: "/b/src/file.ts" } });
  const view = render(<Breadcrumbs className="nav" />);
  const bar = screen.getByRole("navigation", { name: "Breadcrumbs" });
  expect(bar.textContent).toBe("bsrcfile.ts");
  expect(bar.className).toBe("nav");
  view.unmount();
  // View › Appearance › Navigation Bar hides it.
  useProject.setState({
    settings: { appearance: { navigationBar: "hidden" } } as unknown as Settings,
  });
  const hidden = render(<Breadcrumbs className="nav" />);
  expect(screen.queryByRole("navigation", { name: "Breadcrumbs" })).toBeNull();
  hidden.unmount();
  useProject.setState({ project: null, settings: null });
});
