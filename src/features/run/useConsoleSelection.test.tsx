import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConsoleSelection } from "./useConsoleSelection";

const viewport = { startIndex: 100, endIndex: 110, overscan: 2, count: 500 };

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const rows = [5, 6, 7].map((index) => {
    const row = document.createElement("div");
    row.dataset.index = String(index);
    row.textContent = `output ${index}`;
    host.append(row);
    return row;
  });
  const ref = { current: host };
  const pause = vi.fn();
  const hook = renderHook(({ pause }) => useConsoleSelection(ref, pause), { initialProps: { pause } });
  const select = (backward = false) => {
    act(() => {
      const [anchor, focus] = backward ? [rows[2]!, rows[0]!] : [rows[0]!, rows[2]!];
      window.getSelection()!.setBaseAndExtent(anchor.firstChild!, 1, focus.firstChild!, 3);
      document.dispatchEvent(new Event("selectionchange"));
    });
  };
  return { ...hook, host, rows, pause, select };
}

describe("console selection retention", () => {
  it.each([false, true])("keeps the full selected interval mounted (backward=%s)", (backward) => {
    const { result, select, pause } = setup();
    select(backward);
    const indices = result.current.rangeExtractor(viewport);
    expect(indices.slice(0, 3)).toEqual([5, 6, 7]);
    expect(indices).not.toContain(50);
    expect(indices).toContain(100);
    expect(pause).toHaveBeenCalled();
  });

  it("renders the intervening text when dragging beyond the viewport", () => {
    const { result, rows, select } = setup();
    fireEvent.mouseDown(rows[0]!, { button: 0 });
    select();
    const indices = result.current.rangeExtractor(viewport);
    expect(indices[0]).toBe(5);
    expect(indices).toHaveLength(108);
    fireEvent.mouseUp(document);
    expect(result.current.rangeExtractor(viewport)).not.toContain(50);
    expect(result.current.rangeExtractor(viewport)).toContain(5);
  });

  it("releases pinned rows when the selection is cleared or moved outside the console", () => {
    const { result, select } = setup();
    select();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.selecting).toBe(false);
    expect(result.current.rangeExtractor(viewport)[0]).toBe(98);
    select();
    const other = document.createTextNode("other output");
    document.body.append(other);
    act(() => {
      window.getSelection()!.setBaseAndExtent(other, 0, other, 5);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.selecting).toBe(false);
    expect(result.current.rangeExtractor(viewport)[0]).toBe(98);
  });

  it("keeps a drag active when incoming output rerenders the parent", () => {
    const { result, rows, select, rerender } = setup();
    fireEvent.mouseDown(rows[0]!, { button: 0 });
    const pause = vi.fn();
    rerender({ pause });
    select();
    expect(result.current.rangeExtractor(viewport)).toContain(50);
    expect(pause).toHaveBeenCalled();
  });

  it("does not pin rows or pause output for a context click", () => {
    const { result, rows, pause } = setup();
    fireEvent.mouseDown(rows[0]!, { button: 2 });
    expect(result.current.selecting).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });
});
