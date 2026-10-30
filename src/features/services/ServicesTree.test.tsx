import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useServiceProviders, type ServiceTreeItem } from "@/workbench/contributions";
import { ServicesTreeView } from "./ServicesTree";
import { useServicesTree } from "./tree";
import { selectedServices, selectionActions, selectionMenu } from "./selection";

const menu = vi.hoisted(() => vi.fn());
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: menu }));

const roots: ServiceTreeItem[] = ["one", "two", "three"].map((key) => ({ key, label: key, icon: "run" }));
const run = vi.fn();
const stop = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useServicesTree.setState({ roots: {}, selectedKeys: new Set(), selectedKey: null, expanded: new Set() });
  useServiceProviders.setState({
    providers: new Map([
      [
        "test",
        {
          id: "test",
          useRoots: () => roots,
          actions: (item) => [
            { id: "run", title: "Run", icon: "run", run: () => run(item.key) },
            { id: "stop", title: "Stop", icon: "stop", disabled: item.key === "three", run: () => stop(item.key) },
          ],
          menu: (item) => [
            { id: "run", label: item.key === "two" ? "Rerun" : "Run", run: () => run(item.key) },
            { label: "Remove from Services", run: () => remove(item.key) },
          ],
          detail: ({ item }) => <div data-testid="detail">{item.label}</div>,
        },
      ],
    ]),
  });
});

function setup() {
  render(<ServicesTreeView />);
  const tree = screen.getByRole("tree", { name: "Services" });
  const row = (name: string) => within(tree).getByText(name);
  const selected = () =>
    within(tree)
      .getAllByRole("treeitem")
      .filter((r) => r.getAttribute("aria-selected") === "true")
      .map((r) => r.textContent);
  const toolbar = screen.getByRole("toolbar");
  return { tree, row, selected, toolbar };
}

describe("Services selection → actions", () => {
  it.each(["ctrlKey", "metaKey"])("%s toggles rows and Run applies to the selection", (modifier) => {
    const { row, selected, toolbar } = setup();
    fireEvent.mouseDown(row("one"));
    fireEvent.mouseDown(row("two"), { [modifier]: true });
    expect(selected()).toEqual(["one", "two"]);
    expect(screen.getByTestId("detail")).toHaveTextContent("two");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Run" }));
    expect(run.mock.calls).toEqual([["one"], ["two"]]);
    fireEvent.mouseDown(row("one"), { [modifier]: true });
    expect(selected()).toEqual(["two"]);
    fireEvent.mouseDown(row("two"), { [modifier]: true });
    expect(selected()).toEqual([]);
    expect(screen.queryByTestId("detail")).not.toBeInTheDocument();
  });

  it("Shift click selects a range; Stop skips disabled services", () => {
    const { row, selected, toolbar } = setup();
    fireEvent.mouseDown(row("one"));
    fireEvent.mouseDown(row("three"), { shiftKey: true });
    expect(selected()).toEqual(["one", "two", "three"]);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Stop" }));
    expect(stop.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("Shift arrows extend and shrink the selection used by Run", () => {
    const { tree, row, selected, toolbar } = setup();
    fireEvent.mouseDown(row("one"));
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true });
    expect(selected()).toEqual(["one", "two", "three"]);
    fireEvent.keyDown(tree, { key: "ArrowUp", shiftKey: true });
    expect(selected()).toEqual(["one", "two"]);
    fireEvent.click(within(toolbar).getByRole("button", { name: "Run" }));
    expect(run.mock.calls).toEqual([["one"], ["two"]]);
  });

  it("context menu preserves selected rows and batches stable ids and menu-only actions", () => {
    const { row, selected } = setup();
    fireEvent.mouseDown(row("one"));
    fireEvent.mouseDown(row("two"), { metaKey: true });
    fireEvent.contextMenu(row("one"));
    expect(selected()).toEqual(["one", "two"]);
    const items = menu.mock.calls.at(-1)![1];
    items.find((item: { id?: string }) => item.id === "run").run();
    items.find((item: { label?: string }) => item.label === "Remove from Services").run();
    expect(run.mock.calls).toEqual([["one"], ["two"]]);
    expect(remove.mock.calls).toEqual([["one"], ["two"]]);
    fireEvent.contextMenu(row("three"));
    expect(selected()).toEqual(["three"]);
    expect(screen.getByTestId("detail")).toHaveTextContent("three");
    menu.mock.calls.at(-1)![1][0].run();
    expect(run).toHaveBeenLastCalledWith("three");
  });

  it("batches common submenu entries across providers", () => {
    const providers = ["a", "b"].map((id) => ({
      id,
      useRoots: () => [],
      menu: () => [{ label: "Prune", submenu: [{ label: "Containers", run: () => run(id) }] }],
    }));
    const items = selectionMenu(
      providers.map((p) => ({ provider: p.id, item: roots[0]! })),
      providers,
    );
    const submenu = items[0];
    if (submenu && (submenu.kind === undefined || submenu.kind === "item")) {
      const item = submenu.submenu?.[0];
      if (item?.kind === undefined || item?.kind === "item") item?.run?.();
    }
    expect(run.mock.calls).toEqual([["a"], ["b"]]);
  });
});

it("ignores removed rows and avoids invoking a selected group's descendants twice", () => {
  const child = roots[0]!;
  const parent = { key: "group", label: "group", icon: "run", children: [child] };
  const index = new Map([
    [parent.key, { item: parent, provider: "test" }],
    [child.key, { item: child, provider: "test" }],
  ]);
  const selection = selectedServices(new Set([parent.key, child.key, "removed"]), index);
  const actions = selectionActions(selection, [...useServiceProviders.getState().providers.values()]);
  actions.find((a) => a.id === "stop")!.run();
  expect(stop.mock.calls).toEqual([["group"]]);
});

it("disables actions when no selected row can run them", () => {
  const { row, toolbar } = setup();
  fireEvent.mouseDown(row("three"));
  expect(within(toolbar).getByRole("button", { name: "Stop" })).toBeDisabled();
});

it("disables dialog entries for a multi-selection", () => {
  const providers = [{ id: "a", useRoots: () => [], menu: () => [{ label: "Edit Configuration…", run }] }];
  const one = selectionMenu([{ provider: "a", item: roots[0]! }], providers)[0] as { disabled?: boolean };
  const many = selectionMenu(
    roots.slice(0, 2).map((item) => ({ provider: "a", item })),
    providers,
  )[0] as { disabled?: boolean };
  expect(one.disabled).toBeFalsy();
  expect(many.disabled).toBe(true);
});
