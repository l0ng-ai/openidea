import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setShownLine } from "@/editor/api";
import type { OutlineItem } from "@/platform/ipc";

vi.mock("../structure/store", async (orig) => ({
  ...(await orig<typeof import("../structure/store")>()),
  useLiveOutline: () => undefined,
}));

const { StructureView } = await import("../structure/StructureView");
const { useOutline, useStructureOptions } = await import("../structure/store");
const { useTracking } = await import("../common/tracking");

const path = "/p/README.md";
const section = (name: string, line: number): OutlineItem => ({
  name,
  detail: null,
  kind: "heading" as OutlineItem["kind"],
  range: { start: { line, col: 0 }, end: { line: line + 9, col: 0 } },
  selection_range: { start: { line, col: 2 }, end: { line, col: 4 } },
  children: [],
});
const selected = () => screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-selected") === "true");

describe("Structure Autoscroll from Source", () => {
  afterEach(() => {
    cleanup();
    act(() => setShownLine(path, null));
    useTracking.setState({ caret: null });
  });

  it("follows the line a view shows instead of the editor, else the caret", () => {
    useOutline.setState({
      path,
      doc: 1,
      loading: false,
      error: null,
      items: [section("H0", 0), section("H1", 10), section("H2", 20), section("H3", 30)],
    });
    useStructureOptions.setState({ autoscrollFromSource: true });
    useTracking.setState({ caret: { path, doc: 1, line: 12, col: 0, offset: 0 } });
    render(<StructureView />);
    expect(selected()?.textContent).toContain("H1");

    act(() => setShownLine(path, 25));
    expect(selected()?.textContent).toContain("H2");
    act(() => setShownLine("/p/other.md", 35));
    expect(selected()?.textContent).toContain("H2");

    act(() => setShownLine(path, null));
    expect(selected()?.textContent).toContain("H1");
  });
});
