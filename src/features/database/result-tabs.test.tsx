import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { ContextMenuHost, hideContextMenu } from "@/ui";
import { InputDialogsHost } from "@/workbench/inputDialogs";
import { ResultsView } from "./ResultsView";
import { registerResultTabActions } from "./resultTabActions";
import { OUTPUT_TAB, useDatabase, type ResultTab } from "./store";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const actions = [
  ["db.closeResultTab", "Close"],
  ["db.closeOtherResultTabs", "Close Others"],
  ["db.closeAllResultTabs", "Close All"],
  ["db.renameResultTab", "Rename Tab"],
  ["db.nextResultTab", "Select Next Tab"],
  ["db.previousResultTab", "Select Previous Tab"],
] as const;

function result(id: number, title: string, path: string, sourceId: string, value: string): ResultTab {
  const text = `SELECT '${value}' AS value`;
  return {
    id,
    title,
    path,
    sourceId,
    schema: "public",
    page: 0,
    pageSize: 500,
    total: 1,
    outcome: {
      statement: { from: 0, to: text.length, text },
      result: {
        statement: text,
        columns: [{ name: "value", typeName: "text" }],
        rows: [[value]],
        affected: null,
        hasMore: false,
        elapsedMs: 1,
        executionMs: 1,
      },
      error: null,
    },
  };
}

const initialDatabase = useDatabase.getState();
const initialKeymap = useKeymap.getState();
let dispose: () => void;
let seeded: ResultTab[];

beforeEach(() => {
  seeded = [
    result(11, "Customers", "/queries/customers.sql", "customers-db", "customer-row"),
    result(22, "Orders", "/queries/orders.sql", "orders-db", "order-row"),
    result(33, "Customer count", "/queries/customers.sql", "customers-db", "count-row"),
  ];
  useDatabase.setState({
    ...initialDatabase,
    sources: [
      { id: "customers-db", name: "Customers connection", driver: "postgres", readOnly: true },
      { id: "orders-db", name: "Orders connection", driver: "postgres", readOnly: true },
    ],
    consoles: { "/queries/customers.sql": "customers-db", "/queries/orders.sql": "orders-db" },
    consoleSchemas: { "/queries/customers.sql": "public", "/queries/orders.sql": "sales" },
    results: seeded,
    activeResult: 33,
    output: [{ id: 1, time: 0, kind: "info", text: "Both consoles have executed statements." }],
    completion: {},
    details: {},
    running: {},
  });
  useKeymap.setState({ preset: "intellij-macos", overrides: {}, extensions: {} });
  dispose = registerResultTabActions();
});

afterEach(() => {
  act(() => hideContextMenu());
  cleanup();
  dispose();
  useDatabase.setState(initialDatabase, true);
  useKeymap.setState(initialKeymap, true);
});

async function show() {
  await act(async () => {
    render(
      <>
        <ResultsView />
        <ContextMenuHost />
        <InputDialogsHost />
        <button>Outside results</button>
      </>,
    );
  });
}

function tab(name: string) {
  return screen.getByRole("tab", { name });
}

function openMenu(name: string) {
  fireEvent.contextMenu(tab(name), { clientX: 30, clientY: 40, button: 2 });
  return screen.getByRole("menu", { name: "Context menu" });
}

async function choose(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name }));
  });
}

function expectSelected(name: string) {
  expect(tab(name)).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByRole("tab").filter((item) => item.getAttribute("aria-selected") === "true")).toHaveLength(1);
}

function expectOutput() {
  expectSelected("Output");
  expect(useDatabase.getState().activeResult).toBe(OUTPUT_TAB);
  expect(screen.getByRole("log", { name: "Database output" })).toHaveTextContent(
    "Both consoles have executed statements.",
  );
}

function expectConsoleStateUnchanged(before: typeof initialDatabase) {
  const after = useDatabase.getState();
  expect(after.sources).toBe(before.sources);
  expect(after.consoles).toBe(before.consoles);
  expect(after.consoleSchemas).toBe(before.consoleSchemas);
  expect(after.output).toBe(before.output);
}

describe("database result tab context menu", () => {
  it("offers only result actions, in order with the two group separators", async () => {
    await show();
    const menu = openMenu("Orders");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Close", "Close Others", "Close All", "Rename Tab", "Select Next Tab", "Select Previous Tab"]);
    expect(Array.from(menu.children).map((item) => item.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitem",
      "separator",
      "menuitem",
      "separator",
      "menuitem",
      "menuitem",
    ]);
    expect(within(menu).queryByText(/pin|layout/i)).not.toBeInTheDocument();
    expectSelected("Customer count");
    expect(screen.getByRole("gridcell", { name: "count-row" })).toBeInTheDocument();
  });

  it("closes the clicked inactive result without changing the selected result", async () => {
    await show();
    openMenu("Orders");
    await choose("Close");
    expect(screen.queryByRole("tab", { name: "Orders" })).not.toBeInTheDocument();
    expectSelected("Customer count");
    expect(screen.getByRole("gridcell", { name: "count-row" })).toBeInTheDocument();
    expect(useDatabase.getState().results).toEqual([seeded[0], seeded[2]]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("uses the last remaining result, then Output, when closing the active result", async () => {
    await show();
    openMenu("Customer count");
    await choose("Close");
    expectSelected("Orders");
    expect(screen.getByRole("gridcell", { name: "order-row" })).toBeInTheDocument();
    openMenu("Orders");
    await choose("Close");
    expectSelected("Customers");
    openMenu("Customers");
    await choose("Close");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expectOutput();
  });

  it("closes other results across consoles but preserves the clicked inactive result and console state", async () => {
    await show();
    const before = useDatabase.getState();
    openMenu("Orders");
    await choose("Close Others");
    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(["Output", "Orders"]);
    expect(useDatabase.getState().results).toEqual([seeded[1]]);
    expect(useDatabase.getState().results[0]).toBe(seeded[1]);
    expectSelected("Orders");
    expect(screen.getByRole("gridcell", { name: "order-row" })).toBeInTheDocument();
    expectConsoleStateUnchanged(before);
  });

  it.each(["Close Others", "Close All"])("keeps Output when invoking %s from Output", async (action) => {
    await show();
    const before = useDatabase.getState();
    openMenu("Output");
    expectSelected("Customer count");
    await choose(action);
    expect(useDatabase.getState().results).toEqual([]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expectOutput();
    expectConsoleStateUnchanged(before);
  });

  it("closes all result tabs from an inactive result without removing Output or console state", async () => {
    await show();
    const before = useDatabase.getState();
    openMenu("Orders");
    await choose("Close All");
    expect(useDatabase.getState().results).toEqual([]);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expectOutput();
    expectConsoleStateUnchanged(before);
  });

  it("disables Close and Rename Tab on Output and does not perform either operation", async () => {
    await show();
    const before = useDatabase.getState();
    const menu = openMenu("Output");
    for (const name of ["Close", "Rename Tab"]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(item);
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(useDatabase.getState().results).toBe(before.results);
      expectSelected("Customer count");
    }
  });

  it("renames the clicked inactive result using its current title, preserving identity, data and selection", async () => {
    await show();
    const before = useDatabase.getState();
    openMenu("Orders");
    await choose("Rename Tab");
    const dialog = screen.getByRole("dialog", { name: "Rename Tab" });
    const input = within(dialog).getByRole("textbox", { name: "Tab name:" });
    expect(input).toHaveValue("Orders");
    fireEvent.change(input, { target: { value: "  Sales report  " } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "OK" })));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Orders" })).not.toBeInTheDocument();
    expect(tab("Sales report")).toHaveAttribute("aria-selected", "false");
    expectSelected("Customer count");
    expect(useDatabase.getState().results).toEqual([seeded[0], { ...seeded[1], title: "Sales report" }, seeded[2]]);
    expect(useDatabase.getState().results[1]!.outcome).toBe(seeded[1]!.outcome);
    expectConsoleStateUnchanged(before);
    fireEvent.click(tab("Sales report"));
    expect(screen.getByRole("gridcell", { name: "order-row" })).toBeInTheDocument();
    openMenu("Sales report");
    await choose("Rename Tab");
    expect(screen.getByRole("textbox", { name: "Tab name:" })).toHaveValue("Sales report");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
  });

  it.each(["cancel", "blank"])("leaves the result unchanged on a %s rename", async (kind) => {
    await show();
    const before = useDatabase.getState();
    openMenu("Orders");
    await choose("Rename Tab");
    const dialog = screen.getByRole("dialog", { name: "Rename Tab" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tab name:" }), {
      target: { value: kind === "blank" ? "   " : "Do not keep this" },
    });
    if (kind === "blank") {
      expect(within(dialog).getByRole("button", { name: "OK" })).toBeDisabled();
      fireEvent.submit(within(dialog).getByRole("textbox", { name: "Tab name:" }).closest("form")!);
      expect(screen.getByRole("dialog", { name: "Rename Tab" })).toBeInTheDocument();
    }
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(useDatabase.getState().results).toBe(before.results);
    expectSelected("Customer count");
    expect(tab("Orders")).toBeInTheDocument();
  });

  it.each([
    ["Customer count", "Orders", "Select Next Tab", "Output", null],
    ["Customer count", "Customers", "Select Previous Tab", "Orders", "order-row"],
    ["Customers", "Customer count", "Select Previous Tab", "Output", null],
    ["Output", "Customers", "Select Previous Tab", "Customer count", "count-row"],
    ["Output", "Customer count", "Select Next Tab", "Customers", "customer-row"],
    ["Customers", "Output", "Select Next Tab", "Orders", "order-row"],
  ])("navigates from active %s through the %s menu using %s", async (active, clicked, action, selected, value) => {
    useDatabase.setState({ activeResult: seeded.find((r) => r.title === active)?.id ?? OUTPUT_TAB });
    await show();
    openMenu(clicked);
    expectSelected(active);
    await choose(action);
    expectSelected(selected);
    if (value) expect(screen.getByRole("gridcell", { name: value })).toBeInTheDocument();
    else expectOutput();
    expect(useDatabase.getState().results).toBe(seeded);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("navigates from the active tab at execution rather than when the menu opened", async () => {
    await show();
    openMenu("Orders");
    act(() => useDatabase.setState({ activeResult: 11 }));
    expectSelected("Customers");
    await choose("Select Next Tab");
    expectSelected("Orders");
    expect(screen.getByRole("gridcell", { name: "order-row" })).toBeInTheDocument();
    expect(useDatabase.getState().results).toBe(seeded);
  });

  it("cycles between one result and Output in either direction", async () => {
    useDatabase.setState({ results: [seeded[1]!], activeResult: 22 });
    await show();
    for (const action of ["Select Next Tab", "Select Previous Tab"]) {
      openMenu("Output");
      await choose(action);
      expectOutput();
      openMenu("Output");
      await choose(action);
      expectSelected("Orders");
    }
  });

  it("keeps only Output valid when navigating with no result tabs", async () => {
    useDatabase.setState({ results: [], activeResult: OUTPUT_TAB });
    await show();
    for (const action of ["Select Next Tab", "Select Previous Tab"]) {
      openMenu("Output");
      await choose(action);
      expectOutput();
      expect(screen.getAllByRole("tab")).toHaveLength(1);
    }
  });

  it.each(["Escape", "outside"])("dismisses the menu on %s without changing tabs", async (dismiss) => {
    await show();
    const before = useDatabase.getState();
    const menu = openMenu("Orders");
    if (dismiss === "Escape") fireEvent.keyDown(menu, { key: "Escape" });
    else fireEvent.pointerDown(screen.getByRole("button", { name: "Outside results" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(useDatabase.getState().results).toBe(before.results);
    expectSelected("Customer count");
  });

  it("shows each database action's own shortcut override rather than editor tab shortcuts", async () => {
    useKeymap.setState({
      overrides: {
        "editor.closeTab": ["Meta+W"],
        "db.closeResultTab": ["F1"],
        "db.closeOtherResultTabs": ["F2"],
        "db.closeAllResultTabs": ["F3"],
        "db.renameResultTab": ["F4"],
        "db.nextResultTab": ["F5"],
        "db.previousResultTab": ["F6"],
      },
    });
    await show();
    const menu = openMenu("Orders");
    for (const [index, [, label]] of actions.entries()) {
      const item = within(menu).getAllByRole("menuitem")[index]!;
      expect(item).toHaveTextContent(label);
      expect(within(item).getByText(`F${index + 1}`)).toBeInTheDocument();
    }
    expect(within(menu).queryByText("⌘W")).not.toBeInTheDocument();
  });

  it.each([
    ["F10", true],
    ["ContextMenu", false],
  ] as const)("opens the focused inactive tab's menu with %s", async (key, shiftKey) => {
    await show();
    act(() => tab("Orders").focus());
    fireEvent.keyDown(tab("Orders"), { key, code: key, shiftKey });
    expect(screen.getByRole("menu", { name: "Context menu" })).toBeInTheDocument();
    expectSelected("Customer count");
    await choose("Close");
    expect(screen.queryByRole("tab", { name: "Orders" })).not.toBeInTheDocument();
    expectSelected("Customer count");
  });

  it("dispatches assigned result shortcuts only while results have focus, relative to the active tab", async () => {
    useKeymap.setState({
      overrides: {
        "db.nextResultTab": ["F7"],
        "db.previousResultTab": ["F8"],
        "db.closeResultTab": ["F9"],
      },
    });
    await show();
    const uninstall = installKeyboardDispatcher(window);
    const press = async (key: string) => {
      await act(async () => fireEvent.keyDown(document.activeElement!, { key, code: key }));
    };
    try {
      const outside = screen.getByRole("button", { name: "Outside results" });
      act(() => outside.focus());
      for (const key of ["F7", "F8", "F9"]) await press(key);
      expectSelected("Customer count");
      expect(useDatabase.getState().results).toBe(seeded);
      // Focus alone must not select an inactive tab. Argless actions use the selected result.
      act(() => tab("Orders").focus());
      await press("F7");
      expectOutput();
      await press("F8");
      expectSelected("Customer count");
      await press("F9");
      expect(screen.queryByRole("tab", { name: "Customer count" })).not.toBeInTheDocument();
      expectSelected("Orders");
      act(() => outside.focus());
      await press("F9");
      expectSelected("Orders");
      expect(useDatabase.getState().results.map((item) => item.id)).toEqual([11, 22]);
    } finally {
      uninstall();
    }
  });
});
