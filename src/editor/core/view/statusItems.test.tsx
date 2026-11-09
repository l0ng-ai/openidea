import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { OutlineItem, Settings } from "@/platform/ipc";
import type { EditorStatus } from "../controller";

vi.mock("../controller", async () => {
  const { create } = await import("zustand");
  return {
    editorController: () => ({ openFile: vi.fn(), slots: new Map() }),
    useEditorStatus: create<{ status: EditorStatus | null }>(() => ({ status: null })),
    useGotoLine: create(() => ({ open: false })),
  };
});

const { useEditorStatus } = await import("../controller");
const { useOutline } = await import("../model/document");
const { Breadcrumbs, CodeBreadcrumbs, FileBreadcrumbs } = await import("./StatusItems");
const { NavBarPopup } = await import("./NavBarPopup");

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
});

it("shows the member and its directories in workspace breadcrumbs", async () => {
  const { useProject } = await import("@/platform/project");
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: {},
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
  });
  useEditorStatus.setState({ status: { ...caret(0, 0), path: "/b/src/file.ts" } });
  const view = render(<Breadcrumbs />);
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" }).textContent).toBe("bsrcfile.ts");
  view.unmount();
  useProject.setState({ project: null });
});

it("shows the project › dirs › file path above the editor", async () => {
  const { useProject } = await import("@/platform/project");
  useProject.setState({
    project: {
      root: "/workspace",
      name: "Workspace",
      settings: {},
      trusted: true,
      isGit: false,
      workspace: { version: 1, name: "Workspace", projects: ["/a", "/b"] },
    },
  });
  // No editor status needed: the bar follows its tab's file, like IDEA's navigation bar.
  const view = render(<FileBreadcrumbs path="/b/src/deep/file.ts" />);
  expect(screen.getByRole("navigation", { name: "File path" }).textContent).toBe("bsrcdeepfile.ts");
  view.unmount();
  // View › Appearance › Navigation Bar hides it.
  useProject.setState({
    settings: { appearance: { showNavigationBar: false } } as unknown as Settings,
  });
  const hidden = render(<FileBreadcrumbs path="/b/src/deep/file.ts" />);
  expect(screen.queryByRole("navigation", { name: "File path" })).toBeNull();
  hidden.unmount();
  useProject.setState({ project: null, settings: null });
});
