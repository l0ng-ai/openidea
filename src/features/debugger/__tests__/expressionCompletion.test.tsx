import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { completions } = vi.hoisted(() => ({ completions: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, debugCompletions: completions } };
});

import { useDebug, type DebugSession } from "../state";
import { DebuggerOverlays } from "../ui/Overlays";
import { applyCompletion, completionPrefix, matchingCompletions } from "../ui/ExpressionCompletion";
import { openEvaluateDialog, useOverlays } from "../ui/popoverStore";

const session: DebugSession = {
  id: 1,
  name: "main",
  adapter: "java",
  parent: null,
  launch: null,
  process: null,
  status: "paused",
  stoppedThread: 1,
  stopReason: "breakpoint",
  stopDescription: null,
  threads: [{ id: 1, name: "main" }],
  selectedThread: 1,
  frames: [{ id: 7, name: "run", path: "/p/App.java", line: 11, column: 0, presentationHint: null }],
  selectedFrame: 7,
  hits: 1,
  stops: 0,
  exitCode: null,
  caps: null,
};

afterEach(() => {
  act(() => useOverlays.setState({ evaluate: null }));
  completions.mockReset();
  vi.useRealTimers();
});

describe("expression completion", () => {
  it("replaces the identifier before the caret and keeps matching as more is typed", () => {
    expect(completionPrefix("request.getHe", 13)).toBe("getHe");
    expect(completionPrefix("request.", 8)).toBe("");
    const items = [
      { label: "getHeader(String)", text: "getHeader(", kind: "method", detail: null, sortText: null },
      { label: "getMethod()", text: null, kind: "method", detail: null, sortText: null },
    ];
    expect(matchingCompletions(items, "getHe").map((i) => i.label)).toEqual(["getHeader(String)"]);
    expect(applyCompletion("request.getHe + 1", 13, items[0]!)).toEqual({ text: "request.getHeader( + 1", caret: 18 });
    const members = ["__init__", "name", "_cache", "age", "name"].map((label) => ({
      label,
      text: null,
      kind: null,
      detail: null,
      sortText: null,
    }));
    expect(matchingCompletions(members, "").map((i) => i.label)).toEqual(["age", "name", "__init__", "_cache"]);
    expect(matchingCompletions(members, "_").map((i) => i.label)).toEqual(["__init__", "_cache"]);
    const named = ["Request", "request"].map((label) => ({
      label,
      text: null,
      kind: null,
      detail: null,
      sortText: null,
    }));
    expect(matchingCompletions(named, "requ").map((i) => i.label)).toEqual(["request", "Request"]);
  });

  it("offers the adapter's completions in Evaluate for the selected frame and inserts the chosen one", async () => {
    vi.useFakeTimers();
    completions.mockResolvedValue({
      status: "ok",
      data: [
        { label: "clientId", text: null, kind: "variable", detail: "String", sortText: null },
        { label: "clone()", text: "clone()", kind: "method", detail: null, sortText: null },
      ],
    });
    useDebug.setState({ sessions: { 1: session }, active: 1 });
    render(<DebuggerOverlays />);
    act(() => openEvaluateDialog());
    const field = screen.getByRole("textbox", { name: "Expression" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "cl", selectionStart: 2, selectionEnd: 2 } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(completions).toHaveBeenCalledWith(1, 7, "cl", 0, 2);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["clientIdString", "clone()"]);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("clone()");
    expect(screen.queryByRole("option")).toBeNull();
    // The dialog stays open: Enter went to the completion, not to Evaluate.
    expect(useOverlays.getState().evaluate).not.toBeNull();
  });
});
