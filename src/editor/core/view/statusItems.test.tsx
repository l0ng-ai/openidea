import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { OutlineItem } from "@/platform/ipc";
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
const { Breadcrumbs, CodeBreadcrumbs } = await import("./StatusItems");
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
