import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { View, ViewEvent } from "@/bindings";
import { registerAction } from "@/platform/actions";
import { bindingsFor, effectiveBindings, registerExtensionBindings, useKeymap } from "@/platform/keymap";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { pluginMenuItems, withPluginSetting } from "../uiPoints";
import { matchesPattern } from "../views/customEditor";
import { FRAME_CSP, frameDocument } from "../views/frame";
import { PluginView, treeNodes, wantedViewport } from "../views/PluginView";
import { bumpView } from "../views/viewStore";

let undefinePoints: () => void = () => {};

beforeEach(() => {
  undefinePoints = defineBuiltinUiPoints();
});

afterEach(() => {
  clearUiContributions();
  undefinePoints();
  setPluginsBackend(null);
});

function backendWith(render: (view: string) => View, events: ViewEvent[] = []): PluginsBackend {
  const base = createMemoryPluginsBackend([]);
  return {
    ...base,
    renderView: vi.fn(async (_p: string, view: string) => render(view)),
    viewEvent: vi.fn(async (_p: string, _v: string, e: ViewEvent) => void events.push(e)),
  };
}

describe("view helpers", () => {
  it("builds the tree from the flat item list", () => {
    const item = (key: string, parent: string | null = null) => ({
      key,
      parent,
      label: key,
      icon: null,
      detail: null,
      expandable: false,
      expanded: false,
    });
    const roots = treeNodes([item("a"), item("a/1", "a"), item("b"), item("x", "missing")]);
    expect(roots.map((n) => n.item.key)).toEqual(["a", "b", "x"]);
    expect(roots[0]!.children.map((n) => n.item.key)).toEqual(["a/1"]);
  });

  it("asks for the visible table rows plus some around them", () => {
    expect(wantedViewport(0, 20, 10)).toEqual({ firstRow: 0, rows: 10 });
    expect(wantedViewport(1000, 20, 5000)).toEqual({ firstRow: 950, rows: 120 });
  });

  it("confines HTML bodies: CSP without network, a message bridge", () => {
    const doc = frameDocument("<p>hi</p>", true);
    expect(doc).toContain(`content="${FRAME_CSP}"`);
    expect(FRAME_CSP).toContain("default-src 'none'");
    expect(FRAME_CSP).not.toMatch(/https?:|connect-src/);
    expect(doc).toContain("window.openidea = Object.freeze");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>hi</p>"));
  });

  it("matches custom editor file name patterns", () => {
    expect(matchesPattern("*.csv", "People.CSV")).toBe(true);
    expect(matchesPattern("*.{csv,tsv}", "a.tsv")).toBe(true);
    expect(matchesPattern("data?.csv", "data1.csv")).toBe(true);
    expect(matchesPattern("*.csv", "a.csv.bak")).toBe(false);
  });

  it("stores plugin settings under the plugin's id, dropping defaults", () => {
    const one = withPluginSetting(undefined, "p.x", "watch", false);
    expect(one).toEqual({ "p.x": { watch: false } });
    expect(withPluginSetting(one, "p.x", "watch", null)).toEqual({});
  });
});

describe("plugin keymaps", () => {
  afterEach(() => useKeymap.setState({ extensions: {}, overrides: {} }));

  it("adds a plugin's shortcut below the IDE's, never taking a used keystroke", () => {
    const taken = effectiveBindings()[0]!;
    const offFree = registerExtensionBindings("plugin.p.free", ["Ctrl+Alt+Shift+F11"]);
    const offTaken = registerExtensionBindings("plugin.p.taken", [taken[0]]);
    expect(bindingsFor("plugin.p.free")).toEqual(["Ctrl+Alt+Shift+F11"]);
    expect(bindingsFor("plugin.p.taken")).toEqual([]);
    useKeymap.setState({ overrides: { "plugin.p.free": [] } });
    expect(bindingsFor("plugin.p.free")).toEqual([]);
    offFree();
    offTaken();
    expect(useKeymap.getState().extensions).toEqual({});
  });
});

describe("plugin menus", () => {
  it("projects context menu entries for their command's action", () => {
    const off = registerAction({ id: "plugin.p.check", title: "Check", run: () => {} });
    const plugin = {
      id: "p",
      name: "P",
      status: "active",
      enabled: true,
    } as unknown as Parameters<typeof syncUiContributions>[1][number];
    syncUiContributions(
      [
        {
          pluginId: "p",
          point: "menus",
          key: "projectView.context/check",
          decl: { menu: "projectView.context", command: "check" },
        },
        {
          pluginId: "p",
          point: "menus",
          key: "editor.context/check",
          decl: { menu: "editor.context", command: "check", when: "false" },
        },
      ],
      [plugin],
    );
    expect(pluginMenuItems("projectView", ["/p/a.java"])).toEqual([
      { kind: "action", action: "plugin.p.check", arg: "/p/a.java" },
    ]);
    expect(pluginMenuItems("editor", ["/p/a.java"])).toEqual([]);
    off();
  });
});

describe("PluginView", () => {
  it("renders a tree and sends expand / activate", async () => {
    const events: ViewEvent[] = [];
    const tree: View = {
      toolbar: [{ id: "refresh", label: "Refresh", icon: "refresh", enabled: true }],
      body: {
        kind: "tree",
        value: [
          {
            key: "ns",
            parent: null,
            label: "default",
            icon: null,
            detail: "3 pods",
            expandable: true,
            expanded: false,
          },
        ],
      },
      status: "1 namespace",
    };
    setPluginsBackend(backendWith(() => tree, events));
    const user = userEvent.setup();
    render(<PluginView pluginId="k8s" view="clusters" label="Kubernetes" />);
    expect(await screen.findByText("default")).toBeInTheDocument();
    expect(screen.getByText("1 namespace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(events).toContainEqual({ kind: "button", id: "refresh" }));
  });

  it("edits a table cell and renders again when the plugin refreshes", async () => {
    const events: ViewEvent[] = [];
    let city = "London";
    const table = (): View => ({
      toolbar: [],
      body: {
        kind: "table",
        value: { columns: ["name", "city"], totalRows: 1, firstRow: 0, rows: [["Ada", city]], editable: true },
      },
      status: null,
    });
    const backend = backendWith(table, events);
    setPluginsBackend(backend);
    const user = userEvent.setup();
    render(<PluginView pluginId="csv" view="table" doc={7} />);
    await user.dblClick(await screen.findByText("London"));
    const input = screen.getByLabelText("Cell value");
    await user.clear(input);
    await user.type(input, "Paris{Enter}");
    await waitFor(() => expect(events).toContainEqual({ kind: "cell", row: 0, column: 1, value: "Paris" }));
    expect(backend.viewEvent).toHaveBeenCalledWith("csv", "table", expect.anything(), 7);
    city = "Paris";
    bumpView("csv", "table");
    expect(await screen.findByText("Paris")).toBeInTheDocument();
  });

  it("shows a message when the plugin fails", async () => {
    const base = createMemoryPluginsBackend([]);
    setPluginsBackend({ ...base, renderView: () => Promise.reject(new Error("boom")) });
    render(<PluginView pluginId="x" view="v" />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});
