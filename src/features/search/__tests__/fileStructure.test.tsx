import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OutlineItem } from "@/platform/ipc";

const openLocation = vi.hoisted(() => vi.fn());
vi.mock("../common/open", async (orig) => ({
  ...(await orig<typeof import("../common/open")>()),
  openLocation,
}));
vi.mock("../structure/store", async (orig) => ({
  ...(await orig<typeof import("../structure/store")>()),
  useLiveOutline: () => undefined,
}));

const { FileStructureOverlay, useFileStructurePopup } = await import("../structure/StructureView");
const { useOutline, useStructureOptions } = await import("../structure/store");
const { useTracking } = await import("../common/tracking");

const item = (name: string, kind: OutlineItem["kind"], line: number, children: OutlineItem[] = []): OutlineItem => ({
  name,
  detail: null,
  kind,
  range: { start: { line, col: 0 }, end: { line: line + 1, col: 1 } },
  selection_range: { start: { line, col: 4 }, end: { line, col: 4 + name.length } },
  children,
});

function open(
  items = [
    item("OrderController", "class", 0, [item("list", "method", 2), item("create", "method", 8)]),
    item("helper", "function", 22),
  ],
  path = "/p/Order.kt",
) {
  useOutline.setState({
    path,
    doc: 1,
    loading: false,
    error: null,
    items,
  });
  useStructureOptions.setState({ narrowDown: true });
  render(<FileStructureOverlay />);
  act(() => useFileStructurePopup.setState({ open: true }));
  return screen.getByLabelText("Filter symbols");
}

const rows = () => screen.getAllByRole("treeitem").map((r) => r.textContent);
const selected = () => screen.queryByRole("treeitem", { selected: true });
const functionsPath = "/p/functions.ts";

function openFunctions(narrowDown: boolean) {
  useTracking.setState({ caret: { path: functionsPath, doc: 1, line: 6, col: 5, offset: 128 } });
  const input = open([item("process", "function", 0), item("separate", "function", 6)], functionsPath);
  if (!narrowDown) fireEvent.click(screen.getByLabelText("Narrow down on typing"));
  return input;
}

afterEach(() => {
  act(() => useFileStructurePopup.setState({ open: false }));
  useTracking.setState({ caret: null });
  openLocation.mockClear();
});

describe("File Structure popup", () => {
  it("shows the outline as an expanded tree; ←/→ collapse and expand", () => {
    const input = open();
    expect(rows()).toEqual(["OrderController", "list", "create", "helper"]);
    // The first symbol is preselected; ← collapses it, → expands it again.
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(rows()).toEqual(["OrderController", "helper"]);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(rows()).toEqual(["OrderController", "list", "create", "helper"]);
  });

  it("narrows down on typing keeping ancestors, or only highlights when that is off", () => {
    const input = open();
    fireEvent.change(input, { target: { value: "creat" } });
    expect(rows()).toEqual(["OrderController", "create"]);
    fireEvent.click(screen.getByLabelText("Narrow down on typing"));
    expect(useStructureOptions.getState().narrowDown).toBe(false);
    expect(rows()).toEqual(["OrderController", "list", "create", "helper"]);
  });

  it("leaves the full tree unselected when the highlight query stops matching", () => {
    const input = openFunctions(false);
    fireEvent.change(input, { target: { value: "separate" } });
    expect(selected()).toHaveTextContent("separate");
    fireEvent.change(input, { target: { value: "separateZ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useFileStructurePopup.getState().open).toBe(true);
    expect(rows()).toEqual(["process", "separate"]);
    expect(selected()).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
    expect(openLocation).not.toHaveBeenCalled();
  });

  it.each(["", "separate"])("navigates to the intended symbol for query %j", async (query) => {
    const input = openFunctions(false);
    fireEvent.change(input, { target: { value: query } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(openLocation).toHaveBeenCalledWith(functionsPath, { line: 6, col: 4 }, { focus: true }));
  });

  it("still navigates after an explicit selection in the full tree", async () => {
    const input = openFunctions(false);
    fireEvent.change(input, { target: { value: "separateZ" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toHaveTextContent("process");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(openLocation).toHaveBeenCalledWith(functionsPath, { line: 0, col: 4 }, { focus: true }));
  });

  it("keeps narrow mode empty for an unmatched query", () => {
    const input = openFunctions(true);
    fireEvent.change(input, { target: { value: "separateZ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("No symbols")).toBeInTheDocument();
    expect(useFileStructurePopup.getState().open).toBe(true);
    expect(openLocation).not.toHaveBeenCalled();
  });

  it("shows a Vue component's script declarations nested under its script block", () => {
    useOutline.setState({
      path: "/p/App.vue",
      doc: 1,
      loading: false,
      error: null,
      items: [
        item("template", "module", 0),
        { ...item("script", "module", 4), children: [item("App", "function", 8), item("size", "variable", 12)] },
      ],
    });
    render(<FileStructureOverlay />);
    act(() => useFileStructurePopup.setState({ open: true }));
    expect(rows()).toEqual(["template", "script", "App", "size"]);
  });

  it("Esc clears the filter first, then closes", () => {
    const input = open();
    fireEvent.change(input, { target: { value: "help" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(useFileStructurePopup.getState().open).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useFileStructurePopup.getState().open).toBe(false);
  });

  it("offers Show inherited members only when the server knows type hierarchies", () => {
    open();
    expect(screen.queryByLabelText("Show inherited members")).toBeNull();
    const inherited = [{ item: item("toString", "method", 40), path: "/lib/Object.kt", owner: "Any" }];
    act(() => useOutline.setState({ inheritedSupported: true, inherited: new Map([["0:4", inherited]]) }));
    expect(rows()).toEqual(["OrderController", "list", "create", "helper"]);
    fireEvent.click(screen.getByLabelText("Show inherited members"));
    expect(useStructureOptions.getState().showInherited).toBe(true);
    expect(rows()).toEqual(["OrderController", "list", "create", "toString↑Any", "helper"]);
    act(() => {
      useStructureOptions.setState({ showInherited: false });
      useOutline.setState({ inheritedSupported: false, inherited: null });
    });
  });
});
