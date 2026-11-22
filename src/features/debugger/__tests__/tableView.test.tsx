import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const ipc = vi.hoisted(() => ({ debugEvaluateIn: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, ...ipc } };
});

import type { DebugSessionId, Variable } from "@/platform/ipc";
import { adoptSession, useDebug } from "../state";
import { clampWindow, isTableType, parseTableResult, tableExpression } from "../tableView";
import { TableViewDialog } from "../ui/TableViewDialog";
import { VariablesView } from "../ui/VariablesView";
import { useOverlays } from "../ui/popoverStore";
import { hideContextMenu, useContextMenuStore } from "@/ui/Menu";

/** How debugpy shows the helper's JSON reply: Python's repr of a str. */
const pyRepr = (o: unknown) => `'${JSON.stringify(o).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const reply = (o: unknown) =>
  Promise.resolve({
    status: "ok" as const,
    data: { name: "", value: pyRepr(o), typeName: "str", variablesReference: 0, evaluateName: null },
  });

const PAGE = {
  kind: "frame" as const,
  shape: [250, 2],
  rows: 250,
  columns: 2,
  dtypes: ["object", "float64"],
  headers: ["name", "score"],
  index: ["0", "1"],
  cells: [
    ['it\'s "x"', "1.5"],
    ["日本", "nan"],
  ],
};

function session(adapter = "debugpy") {
  useDebug.setState({ sessions: {}, active: null });
  adoptSession(7, { adapter });
  useDebug.setState((s) => ({
    sessions: { 7: { ...s.sessions[7]!, status: "paused", selectedFrame: 10 } },
    active: 7,
  }));
}

/** A `stopped` event as `state.ts` records it: the frame is unknown until the stack trace arrives. */
function stop(frame: number | null) {
  act(() =>
    useDebug.setState((s) => ({
      sessions: {
        7: { ...s.sessions[7]!, stops: s.sessions[7]!.stops + (frame == null ? 1 : 0), selectedFrame: frame },
      },
    })),
  );
}

beforeEach(() => session());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useDebug.setState({ sessions: {}, active: null });
  useOverlays.setState({ tableView: null });
});

describe("table view model", () => {
  it("knows the types debugpy reports for DataFrame, Series and ndarray", () => {
    expect(["DataFrame", "Series", "ndarray"].every(isTableType)).toBe(true);
    expect(isTableType("list")).toBe(false);
    expect(isTableType(null)).toBe(false);
  });

  it("reads the helper's reply through Python's string quoting", () => {
    expect(parseTableResult(pyRepr(PAGE))).toEqual({ page: PAGE });
    expect(parseTableResult(pyRepr({ error: "ndim", ndim: 3 }))).toEqual({ error: "ndim", ndim: 3 });
    expect(parseTableResult("NameError: name 'df' is not defined")).toEqual({
      error: "NameError: name 'df' is not defined",
    });
  });

  it("moves a window the object no longer reaches back to its last page", () => {
    const w = { row: 100, column: 30 };
    expect(clampWindow(w, { rows: 250, columns: 45 })).toBe(w);
    expect(clampWindow({ row: 200, column: 30 }, { rows: 50, columns: 45 })).toEqual({ row: 0, column: 30 });
    expect(clampWindow({ row: 200, column: 30 }, { rows: 150, columns: 12 })).toEqual({ row: 100, column: 0 });
    expect(clampWindow({ row: 100, column: 0 }, { rows: 0, columns: 0 })).toEqual({ row: 0, column: 0 });
  });

  it("passes the expression outside the helper's lambda, with the page window", () => {
    const e = tableExpression("frames['a']", { row: 100, column: 30 });
    expect(e).toMatch(
      /^\(lambda g, o: \(exec\(".*", g\), g\['f'\]\(o, 100, 100, 30, 30\)\)\[1\]\)\(\{\}, \(frames\['a'\]\)\)$/s,
    );
  });
});

describe("View as Table", () => {
  it("shows a page with headers, dtypes and index, and fetches the next rows on demand", async () => {
    ipc.debugEvaluateIn.mockImplementation(() => reply(PAGE));
    render(<TableViewDialog expression="df" session={7 as DebugSessionId} onClose={() => {}} />);
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["", "nameobject", "scorefloat64"]);
    expect(within(table).getAllByRole("row")[1]!.textContent).toBe('0it\'s "x"1.5');
    expect(screen.getByText("Shape (250, 2)")).toBeInTheDocument();
    expect(screen.getByText("Rows 1–100 of 250")).toBeInTheDocument();
    expect(ipc.debugEvaluateIn).toHaveBeenCalledWith(7, 10, tableExpression("df", { row: 0, column: 0 }), "clipboard");

    fireEvent.click(screen.getByRole("button", { name: "Next Rows" }));
    await waitFor(() =>
      expect(ipc.debugEvaluateIn).toHaveBeenLastCalledWith(
        7,
        10,
        tableExpression("df", { row: 100, column: 0 }),
        "clipboard",
      ),
    );
    expect(await screen.findByText("Rows 101–200 of 250")).toBeInTheDocument();
  });

  it("asks for a 2-D slice of an array with more dimensions", async () => {
    ipc.debugEvaluateIn.mockImplementation(() => reply({ error: "ndim", ndim: 3 }));
    render(<TableViewDialog expression="a" session={7 as DebugSessionId} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("A 3-dimensional array can't be shown as a table");
  });

  it("shows the exception of an expression that fails in the frame", async () => {
    // With the `clipboard` context debugpy answers with the exception's repr as the value.
    ipc.debugEvaluateIn.mockImplementation(() =>
      Promise.resolve({
        status: "ok" as const,
        data: {
          name: "",
          value: `NameError("name 'df' is not defined")`,
          typeName: "NameError",
          variablesReference: 3,
          evaluateName: null,
        },
      }),
    );
    render(<TableViewDialog expression="df" session={7 as DebugSessionId} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(`NameError("name 'df' is not defined")`);
  });

  it("goes back to the last page when a step leaves the object shorter than the page shown", async () => {
    let rows = 250;
    ipc.debugEvaluateIn.mockImplementation(() => reply({ ...PAGE, rows, shape: [rows, 2] }));
    render(<TableViewDialog expression="df" session={7 as DebugSessionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next Rows" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next Rows" }));
    expect(await screen.findByText("Rows 201–250 of 250")).toBeInTheDocument();

    rows = 50;
    stop(null);
    stop(10);
    await waitFor(() =>
      expect(ipc.debugEvaluateIn).toHaveBeenLastCalledWith(
        7,
        10,
        tableExpression("df", { row: 0, column: 0 }),
        "clipboard",
      ),
    );
    expect(await screen.findByText("Shape (50, 2)")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("waits for the stopped frame, and doesn't show the previous stop's page meanwhile", async () => {
    ipc.debugEvaluateIn.mockImplementation(() => reply(PAGE));
    render(<TableViewDialog expression="df" session={7 as DebugSessionId} onClose={() => {}} />);
    await screen.findByRole("table");
    ipc.debugEvaluateIn.mockClear();
    let answer: (v: unknown) => void = () => {};
    ipc.debugEvaluateIn.mockImplementation(() => new Promise((r) => (answer = r)));

    stop(null);
    expect(ipc.debugEvaluateIn).not.toHaveBeenCalled();
    expect(screen.queryByRole("table")).toBeNull();
    stop(12);
    expect(ipc.debugEvaluateIn).toHaveBeenCalledExactlyOnceWith(
      7,
      12,
      tableExpression("df", { row: 0, column: 0 }),
      "clipboard",
    );
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => answer(await reply(PAGE)));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("puts a DataFrame's dtypes on its columns even when the page has one column", async () => {
    ipc.debugEvaluateIn.mockImplementation(() =>
      reply({ ...PAGE, shape: [250, 31], columns: 31, dtypes: ["float64"], headers: ["z"], cells: [["1.0"], ["2.0"]] }),
    );
    render(<TableViewDialog expression="df" session={7 as DebugSessionId} onClose={() => {}} />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")[1]).toHaveTextContent("zfloat64");
    expect(screen.getByText("Shape (250, 31)")).toBeInTheDocument();
  });

  const frame: Variable = {
    name: "df",
    value: "   a\n0  1",
    typeName: "DataFrame",
    variablesReference: 5,
    evaluateName: "df",
  };
  const menuFor = (v: Variable) => {
    render(
      <VariablesView roots={[{ key: "df", kind: "var", variable: v, container: 1 }]} session={7 as DebugSessionId} />,
    );
    fireEvent.contextMenu(screen.getByRole("treeitem"));
    const labels = (useContextMenuStore.getState().menu?.items ?? []).map((i) => ("label" in i ? i.label : "|"));
    hideContextMenu();
    cleanup();
    return labels;
  };

  it("is offered for a DataFrame in a Python session, and opens outside the Variables view", () => {
    render(
      <VariablesView
        roots={[{ key: "df", kind: "var", variable: frame, container: 1 }]}
        session={7 as DebugSessionId}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("treeitem"));
    const item = useContextMenuStore.getState().menu?.items.find((i) => "label" in i && i.label === "View as Table");
    act(() => hideContextMenu());
    expect(item && "run" in item).toBe(true);
    if (item && "run" in item) item.run?.();
    // The Variables view unmounts while the program runs; the viewer stays open across steps.
    expect(useOverlays.getState().tableView).toEqual({ expression: "df", session: 7 });
  });

  it("is not offered for other values or other debuggers", () => {
    expect(menuFor({ ...frame, typeName: "list" })).not.toContain("View as Table");
    session("lldb");
    expect(menuFor(frame)).not.toContain("View as Table");
  });
});
