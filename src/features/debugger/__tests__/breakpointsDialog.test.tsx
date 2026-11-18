import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { provideEditorService } from "@/workbench/contributions";
import { addBreakpoint, useBreakpoints } from "../breakpoints/store";
import { DebuggerOverlays } from "../ui/Overlays";
import { useOverlays } from "../ui/popoverStore";

const openFile = vi.fn(async () => undefined);
provideEditorService({ openFile } as never);

const path = "/p/main.py";

describe("the Breakpoints dialog", () => {
  beforeEach(() => {
    openFile.mockClear();
    useBreakpoints.setState({ byFile: {}, status: {}, muted: false });
    const first = addBreakpoint(path, 2, { condition: "value == 2" });
    addBreakpoint(path, 6);
    useOverlays.setState({ breakpoints: { id: first.id } } as never);
  });
  afterEach(() => {
    cleanup();
    act(() => useOverlays.setState({ breakpoints: null } as never));
  });

  const dialog = () => screen.getByRole("dialog", { name: "Breakpoints" });
  const row = (name: string) => within(within(dialog()).getByLabelText("All breakpoints")).getByText(name);
  const condition = () => within(dialog()).getByLabelText("Condition") as HTMLInputElement;
  /** A row's mouse click as the list sees it: mousedown selects, click (with its count) activates. */
  const clickRow = (name: string, detail: number) => {
    fireEvent.mouseDown(row(name), { button: 0 });
    fireEvent.click(row(name), { detail });
  };
  const breakpointAt = (line: number) => useBreakpoints.getState().byFile[path]!.find((b) => b.line === line)!;

  it("selects a breakpoint on click and goes to its source on double-click", () => {
    render(<DebuggerOverlays />);
    clickRow("main.py:7", 1);
    expect(openFile).not.toHaveBeenCalled();
    // Its details show beside the list.
    expect(within(dialog()).getAllByText("main.py:7")).toHaveLength(2);
    clickRow("main.py:3", 2);
    expect(openFile).toHaveBeenCalledWith(path, { selection: { line: 2, col: 0 } });
  });

  it("saves the condition being typed when the dialog closes or another breakpoint is shown", () => {
    render(<DebuggerOverlays />);
    fireEvent.change(condition(), { target: { value: "value == 1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(breakpointAt(2).condition).toBe("value == 1");

    act(() => useOverlays.setState({ breakpoints: { id: breakpointAt(2).id } } as never));
    fireEvent.change(condition(), { target: { value: "value == 3" } });
    clickRow("main.py:7", 1);
    expect(breakpointAt(2).condition).toBe("value == 3");
  });
});
