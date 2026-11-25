import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { provideEditorService } from "@/workbench/contributions";
import { addBreakpoint, useBreakpoints } from "../breakpoints/store";
import { useExceptionBreakpoints } from "../breakpoints/exceptions";
import { loadExceptionClasses, removeAllExceptionClasses, useExceptionClasses } from "../breakpoints/exceptionClasses";
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
  const row = (location: string) =>
    within(within(dialog()).getByRole("listbox", { name: "All breakpoints" })).getByRole("option", {
      name: (name) => name.includes(`Enable breakpoint at ${location}`),
    });
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
    expect(row("main.py:7").getAttribute("aria-selected")).toBe("true");
    expect(condition().value).toBe("");
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

  describe("Java exception breakpoints", () => {
    beforeEach(() => {
      loadExceptionClasses("/p");
      removeAllExceptionClasses();
      useExceptionBreakpoints.setState({ root: "/p", choices: {} });
    });

    const list = () => within(dialog()).getByRole("listbox", { name: "All breakpoints" });

    it("shows java-debug's filters as Any exception, under the choices they had", () => {
      render(<DebuggerOverlays />);
      expect(within(list()).getByText("Java Exception Breakpoints")).toBeTruthy();
      expect(within(dialog()).queryByRole("group", { name: "java-debug exception filters" })).toBeNull();
      fireEvent.click(within(list()).getByRole("checkbox", { name: "Enable Any exception" }));
      expect(useExceptionBreakpoints.getState().choices).toEqual({
        "java-debug:caught": true,
        "java-debug:uncaught": true,
      });
      fireEvent.mouseDown(within(list()).getByRole("option", { name: /Any exception/ }), { button: 0 });
      const suspend = within(dialog()).getByRole("group", { name: "Suspend on" });
      fireEvent.click(within(suspend).getByRole("checkbox", { name: "Caught exception" }));
      expect(useExceptionBreakpoints.getState().choices["java-debug:caught"]).toBe(false);
    });

    it("adds one for a class, with its class filters, and IDEA's other fields disabled", () => {
      render(<DebuggerOverlays />);
      fireEvent.click(within(dialog()).getByRole("button", { name: "Add Java Exception Breakpoint" }));
      fireEvent.change(within(dialog()).getByLabelText("Exception class name"), {
        target: { value: " com.acme.Boom " },
      });
      const patterns = within(dialog()).getByLabelText("Class filter patterns") as HTMLInputElement;
      expect(patterns.disabled).toBe(true);
      fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Class filters" }));
      fireEvent.change(patterns, { target: { value: "com.acme.* -*Test" } });
      for (const field of ["Condition", "Catch class filters"]) {
        expect((within(dialog()).getByRole("checkbox", { name: field }) as HTMLInputElement).disabled).toBe(true);
      }
      for (const input of ["Condition expression", "Catch class filter patterns"]) {
        expect((within(dialog()).getByLabelText(input) as HTMLInputElement).disabled).toBe(true);
      }
      fireEvent.click(within(dialog()).getByRole("button", { name: "Done" }));
      expect(useExceptionClasses.getState().list).toEqual([
        expect.objectContaining({
          className: "com.acme.Boom",
          caught: true,
          uncaught: true,
          classFilters: "com.acme.* -*Test",
          classFiltersEnabled: true,
        }),
      ]);
    });
  });
});
