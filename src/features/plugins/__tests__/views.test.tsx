import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenuHost, hideContextMenu } from "@/ui";
import type { View, ViewEvent } from "@/bindings";
import { registerAction } from "@/platform/actions";
import { bindingsFor, effectiveBindings, registerExtensionBindings, useKeymap } from "@/platform/keymap";
import { createMemoryPluginsBackend, setPluginsBackend, type PluginsBackend } from "../backend";
import { commandArgs, defineBuiltinUiPoints } from "../points";
import { clearUiContributions, syncUiContributions } from "../projection";
import { pluginMenuItems, pluginViewItemMenuItems, withPluginSetting } from "../uiPoints";
import { matchesPattern } from "../views/customEditor";
import { FRAME_CSP, FRAME_TAG, frameDocument, frameTheme, type FrameTheme } from "../views/frame";
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
    const doc = frameDocument("<p>hi</p>", { dark: true, vars: {} });
    expect(doc).toContain(`content="${FRAME_CSP}"`);
    expect(FRAME_CSP).toContain("default-src 'none'");
    expect(FRAME_CSP).not.toMatch(/https?:|connect-src/);
    expect(doc).toContain("window.openidea = Object.freeze");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>hi</p>"));
  });

  it("reads the frame theme from the IDE tokens, resolved and sanitised", () => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.style.setProperty("--fg", "#112233");
    root.style.setProperty("--font-ui", "Inter, sans-serif");
    root.style.setProperty("--font-mono", "x}</style><script>alert(1)</script>");
    try {
      root.dataset.theme = "light";
      const light = frameTheme();
      expect(light.dark).toBe(false);
      expect(light.vars["--openidea-fg"]).toBe("rgb(17, 34, 51)");
      expect(light.vars["--openidea-font-ui"]).toBe("Inter, sans-serif");
      expect(light.vars).not.toHaveProperty("--openidea-font-mono");
      root.dataset.theme = "dark";
      root.dataset.contrast = "high";
      expect(frameTheme().dark).toBe(true);
    } finally {
      for (const p of ["--fg", "--font-ui", "--font-mono"]) root.style.removeProperty(p);
      delete root.dataset.contrast;
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    }
  });

  it("puts the theme into the frame document without letting a value end the script", () => {
    const doc = frameDocument("<p>hi</p>", { dark: true, vars: { "--openidea-fg": "</script><b>" } });
    expect(doc).toContain('<html data-theme="dark">');
    expect(doc).not.toContain("</script><b>");
    expect(doc).toContain("\\u003c/script>");
  });

  it("applies posted themes inside the frame, replacing the previous variables", () => {
    const doc = frameDocument("", {
      dark: false,
      vars: { "--openidea-fg": "rgb(1, 2, 3)", "--openidea-accent": "red" },
    });
    const script = /<script>([\s\S]*)<\/script>/.exec(doc)![1]!;
    const root = document.documentElement;
    const before = root.dataset.theme;
    const seen: unknown[] = [];
    try {
      new Function(script)();
      const api = (
        window as unknown as { openidea: { theme: FrameTheme; onThemeChange(fn: (t: FrameTheme) => void): void } }
      ).openidea;
      expect(root.style.getPropertyValue("--openidea-fg")).toBe("rgb(1, 2, 3)");
      expect(api.theme.dark).toBe(false);
      api.onThemeChange((t) => seen.push(t));
      // jsdom's postMessage has no `source`, so dispatch the event as the parent would.
      const send = (t: unknown) =>
        window.dispatchEvent(new MessageEvent("message", { data: { tag: FRAME_TAG, theme: t }, source: window }));
      send({ dark: true, vars: { "--openidea-fg": "rgb(9, 9, 9)", "--not-ours": "x" } });
      expect(root.dataset.theme).toBe("dark");
      expect(root.style.getPropertyValue("--openidea-fg")).toBe("rgb(9, 9, 9)");
      expect(root.style.getPropertyValue("--openidea-accent")).toBe("");
      expect(root.style.getPropertyValue("--not-ours")).toBe("");
      expect(seen).toHaveLength(1);
    } finally {
      for (const p of ["--openidea-fg", "--openidea-accent"]) root.style.removeProperty(p);
      delete (window as unknown as { openidea?: unknown }).openidea;
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    }
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
  it("unpacks command arguments", () => {
    expect(commandArgs("x")).toEqual(["x", []]);
    expect(commandArgs({ path: "/a", paths: ["/a", "/b"] })).toEqual(["/a", ["/a", "/b"]]);
    expect(commandArgs(undefined)).toEqual([null, []]);
    expect(commandArgs({ path: 3 })).toEqual([null, []]);
  });

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
      { kind: "action", action: "plugin.p.check", arg: { path: "/p/a.java", paths: ["/p/a.java"] } },
    ]);
    expect(pluginMenuItems("projectView", ["/p/a.java", "/p/b.java"])[0]).toMatchObject({
      arg: { path: "/p/a.java", paths: ["/p/a.java", "/p/b.java"] },
    });
    expect(pluginMenuItems("editor", ["/p/a.java"])).toEqual([]);
    syncUiContributions(
      [
        {
          pluginId: "p",
          point: "menus",
          key: "editor.context/always",
          decl: { menu: "editor.context", command: "check" },
        },
      ],
      [plugin],
    );
    expect(pluginMenuItems("editor", ["/p/a.java"])).toEqual([
      { kind: "action", action: "plugin.p.check", arg: undefined },
    ]);
    off();
  });

  it("projects view item menu entries with the item key as argument", () => {
    const off = registerAction({ id: "plugin.k.logs", title: "Logs", run: () => {} });
    syncUiContributions(
      [
        {
          pluginId: "k",
          point: "menus",
          key: "viewItem.context/res/logs",
          decl: {
            menu: "viewItem.context",
            view: "res",
            command: "logs",
            when: "viewItemKind == pod",
          },
        },
      ],
      [
        { id: "k", name: "K", status: "active", enabled: true } as unknown as Parameters<
          typeof syncUiContributions
        >[1][number],
      ],
    );
    expect(pluginViewItemMenuItems("k", "res", "pod:default:nginx")).toEqual([
      { kind: "action", action: "plugin.k.logs", arg: "pod:default:nginx" },
    ]);
    expect(pluginViewItemMenuItems("k", "res", "svc:default/web")).toEqual([]);
    expect(pluginViewItemMenuItems("k", "other", "pod:x")).toEqual([]);
    expect(pluginViewItemMenuItems("other", "res", "pod:x")).toEqual([]);
    expect(pluginMenuItems("projectView", ["/p/a"])).toEqual([]);
    off();
  });

  it("groups one plugin's entries that name the same submenu", () => {
    const off = [
      registerAction({ id: "plugin.p.watch", title: "Watch", category: "P", run: () => {} }),
      registerAction({ id: "plugin.p.trace", title: "Trace", category: "P", run: () => {} }),
      registerAction({ id: "plugin.p.single", title: "Single", category: "P", run: () => {} }),
      registerAction({ id: "plugin.p.plain", title: "Plain", category: "P", run: () => {} }),
    ];
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
          key: "editor.context/watch",
          decl: { menu: "editor.context", command: "watch", submenu: "Arthas" },
        },
        {
          pluginId: "p",
          point: "menus",
          key: "editor.context/trace",
          decl: { menu: "editor.context", command: "trace", submenu: "Arthas" },
        },
        {
          pluginId: "p",
          point: "menus",
          key: "editor.context/single",
          decl: { menu: "editor.context", command: "single", submenu: "Other" },
        },
        {
          pluginId: "p",
          point: "menus",
          key: "editor.context/plain",
          decl: { menu: "editor.context", command: "plain" },
        },
      ],
      [plugin],
    );
    expect(pluginMenuItems("editor", ["/p/a.java"])).toEqual([
      {
        kind: "item",
        label: "Arthas",
        verbatim: true,
        submenu: [
          { kind: "action", action: "plugin.p.watch", arg: undefined },
          { kind: "action", action: "plugin.p.trace", arg: undefined },
        ],
      },
      { kind: "action", action: "plugin.p.single", arg: undefined },
      { kind: "action", action: "plugin.p.plain", arg: undefined },
    ]);
    for (const dispose of off) dispose();
  });
});

describe("PluginView", () => {
  afterEach(() => hideContextMenu());

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
    render(<PluginView pluginId="jobs" view="jobs" label="Jobs" />);
    expect(await screen.findByText("default")).toBeInTheDocument();
    expect(screen.getByText("1 namespace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(events).toContainEqual({ kind: "button", id: "refresh" }));
  });

  it("opens the item menu on right-click", async () => {
    const tree: View = {
      toolbar: [],
      body: {
        kind: "tree",
        value: [
          { key: "ns", parent: null, label: "default", icon: null, detail: null, expandable: false, expanded: false },
        ],
      },
      status: null,
    };
    setPluginsBackend(backendWith(() => tree));
    const itemMenu = vi.fn((key: string) => (key === "ns" ? [{ label: "Describe", run: () => {} }] : []));
    render(
      <>
        <PluginView pluginId="jobs" view="jobs" itemMenu={itemMenu} />
        <ContextMenuHost />
      </>,
    );
    await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByText("default") });
    expect(itemMenu).toHaveBeenCalledWith("ns");
    expect(await screen.findByText("Describe")).toBeTruthy();
  });

  it("opens the item menu on a list row, and none when it has no entries", async () => {
    const list: View = {
      toolbar: [],
      body: {
        kind: "list",
        value: [
          { key: "a", label: "Alpha", icon: null, detail: null },
          { key: "b", label: "Beta", icon: null, detail: null },
        ],
      },
      status: null,
    };
    setPluginsBackend(backendWith(() => list));
    const itemMenu = vi.fn((key: string) => (key === "a" ? [{ label: "Open Alpha", run: () => {} }] : []));
    render(
      <>
        <PluginView pluginId="jobs" view="jobs" itemMenu={itemMenu} />
        <ContextMenuHost />
      </>,
    );
    await userEvent.pointer({ keys: "[MouseRight]", target: await screen.findByText("Alpha") });
    expect(itemMenu).toHaveBeenCalledWith("a");
    expect(await screen.findByText("Open Alpha")).toBeTruthy();
    hideContextMenu();
    await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByText("Beta") });
    expect(itemMenu).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("edits a table cell and renders again when the plugin refreshes", async () => {
    const events: ViewEvent[] = [];
    let city = "London";
    const table = (): View => ({
      toolbar: [],
      body: {
        kind: "table",
        value: {
          columns: ["name", "city"],
          totalRows: 1,
          firstRow: 0,
          rows: [["Ada", city]],
          editable: true,
          sortable: false,
          sort: null,
        },
      },
      status: null,
    });
    const backend = backendWith(table, events);
    setPluginsBackend(backend);
    const user = userEvent.setup();
    render(<PluginView pluginId="csv" view="table" doc={7} />);
    await user.dblClick(await screen.findByText("London"));
    const input = screen.getByLabelText("Cell value");
    expect(events.some((e) => e.kind === "tableActivate")).toBe(false);
    await user.clear(input);
    await user.type(input, "Paris{Enter}");
    await waitFor(() => expect(events).toContainEqual({ kind: "cell", row: 0, column: 1, value: "Paris" }));
    expect(backend.viewEvent).toHaveBeenCalledWith("csv", "table", expect.anything(), 7);
    city = "Paris";
    bumpView("csv", "table");
    expect(await screen.findByText("Paris")).toBeInTheDocument();
  });

  it("sorts a sortable table from its column headers, inverting on a second click", async () => {
    const events: ViewEvent[] = [];
    let sort: { column: number; descending: boolean } | null = null;
    const table = (): View => ({
      toolbar: [],
      body: {
        kind: "table",
        value: {
          columns: ["ext", "files"],
          totalRows: 1,
          firstRow: 0,
          rows: [["rs", "2"]],
          editable: false,
          sortable: true,
          sort,
        },
      },
      status: null,
    });
    setPluginsBackend(backendWith(table, events));
    const user = userEvent.setup();
    const { container } = render(<PluginView pluginId="ext" view="counts" />);
    const header = await screen.findByRole("columnheader", { name: "files" });

    await user.click(header);
    await waitFor(() => expect(events).toContainEqual({ kind: "sort", column: 1, descending: false }));

    sort = { column: 1, descending: false };
    bumpView("ext", "counts");
    await waitFor(() =>
      expect(screen.getByRole("columnheader", { name: "files" })).toHaveAttribute("aria-sort", "ascending"),
    );
    expect(container.querySelector('[aria-sort="ascending"] svg')).not.toBeNull();

    await user.click(screen.getByRole("columnheader", { name: "files" }));
    await waitFor(() => expect(events).toContainEqual({ kind: "sort", column: 1, descending: true }));

    sort = { column: 1, descending: true };
    bumpView("ext", "counts");
    await waitFor(() =>
      expect(screen.getByRole("columnheader", { name: "files" })).toHaveAttribute("aria-sort", "descending"),
    );

    // Another column starts over at ascending.
    await user.click(screen.getByRole("columnheader", { name: "ext" }));
    await waitFor(() => expect(events).toContainEqual({ kind: "sort", column: 0, descending: false }));
    expect(events.filter((e) => e.kind === "sort")).toHaveLength(3);
  });

  it("keeps plain table headers inert", async () => {
    const events: ViewEvent[] = [];
    const table = (): View => ({
      toolbar: [],
      body: {
        kind: "table",
        value: {
          columns: ["name", "city"],
          totalRows: 1,
          firstRow: 0,
          rows: [["Ada", "London"]],
          editable: false,
          sortable: false,
          sort: null,
        },
      },
      status: null,
    });
    setPluginsBackend(backendWith(table, events));
    const user = userEvent.setup();
    render(<PluginView pluginId="csv" view="table" />);
    await user.click(await screen.findByRole("columnheader", { name: "city" }));
    expect(events).toHaveLength(0);
  });

  it("keeps an HTML body loaded across theme switches and posts the new theme to it", async () => {
    const html: View = { toolbar: [], body: { kind: "html", value: "<p>chart</p>" }, status: null };
    setPluginsBackend(backendWith(() => html, []));
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = "light";
    try {
      const { container } = render(<PluginView pluginId="charts" view="chart" />);
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const frame = container.querySelector("iframe")!;
      const srcDoc = frame.getAttribute("srcdoc");
      expect(srcDoc).toContain('<html data-theme="light">');
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      root.dataset.theme = "dark";
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith({ tag: FRAME_TAG, theme: expect.objectContaining({ dark: true }) }, "*"),
      );
      expect(frame.getAttribute("srcdoc")).toBe(srcDoc);
    } finally {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    }
  });

  it("shows a message when the plugin fails", async () => {
    const base = createMemoryPluginsBackend([]);
    setPluginsBackend({ ...base, renderView: () => Promise.reject(new Error("boom")) });
    render(<PluginView pluginId="x" view="v" />);
    expect(await screen.findByText("boom")).toBeInTheDocument();
  });
});

describe("API 1.3 read-only values and table rows", () => {
  it("shows selectable labels and readonly text without sending field changes", async () => {
    const events: ViewEvent[] = [];
    setPluginsBackend(
      backendWith(
        () => ({
          toolbar: [],
          status: null,
          body: {
            kind: "form",
            value: [
              { key: "title", label: "Title", value: { kind: "label", value: "Merge request" } },
              {
                key: "author",
                label: "Author",
                value: { kind: "readonlyText", value: { text: "Ada", multiline: false } },
              },
              {
                key: "body",
                label: "Description",
                value: { kind: "readonlyText", value: { text: "one\ntwo", multiline: true } },
              },
            ],
          },
        }),
        events,
      ),
    );
    const user = userEvent.setup();
    render(<PluginView pluginId="jobs" view="form" />);
    expect(await screen.findByLabelText("Title")).toHaveTextContent("Merge request");
    for (const label of ["Author", "Description"]) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute("readonly");
      await user.type(input, "changed");
      await user.tab();
    }
    expect(screen.getByLabelText("Author")).toHaveValue("Ada");
    expect(screen.getByLabelText("Description")).toHaveValue("one\ntwo");
    expect(events).toEqual([]);
  });

  it("keeps editable table row actions beside contributed commands", async () => {
    const events: ViewEvent[] = [];
    setPluginsBackend(
      backendWith(
        () => ({
          toolbar: [],
          status: null,
          body: {
            kind: "table",
            value: {
              columns: ["Value"],
              rows: [["Editable"]],
              totalRows: 1,
              firstRow: 0,
              editable: true,
              sortable: false,
              sort: null,
            },
          },
        }),
        events,
      ),
    );
    const user = userEvent.setup();
    render(
      <>
        <ContextMenuHost />
        <PluginView pluginId="jobs" view="table" itemMenu={() => [{ label: "Inspect editable", run: () => {} }]} />
      </>,
    );
    const cell = await screen.findByText("Editable");
    await user.pointer({ target: cell, keys: "[MouseRight]" });
    expect(screen.getByText("Inspect editable")).toBeInTheDocument();
    expect(screen.getByText("Insert Row Above")).toBeInTheDocument();
    await user.click(screen.getByText("Delete Row"));
    expect(events).toContainEqual({ kind: "deleteRows", rows: [0] });
    hideContextMenu();
  });

  it("uses absolute row indices after paging and supports keyboard context menus", async () => {
    const events: ViewEvent[] = [];
    const itemMenu = vi.fn(() => [{ label: "Inspect paged row", run: () => {} }]);
    setPluginsBackend(
      backendWith(
        () => ({
          toolbar: [],
          status: null,
          body: {
            kind: "table",
            value: {
              columns: ["Route"],
              rows: [["/paged"]],
              totalRows: 100,
              firstRow: 50,
              editable: false,
              sortable: true,
              sort: null,
            },
          },
        }),
        events,
      ),
    );
    const user = userEvent.setup();
    render(
      <>
        <ContextMenuHost />
        <PluginView pluginId="jobs" view="routes" itemMenu={itemMenu} />
      </>,
    );
    const grid = await screen.findByRole("grid");
    fireEvent.scroll(grid, { target: { scrollTop: 50 * 24 } });
    const cell = await screen.findByText("/paged");
    await user.click(cell);
    expect(events).toContainEqual({ kind: "tableSelect", row: 50 });
    (cell.closest('[role="row"]') as HTMLElement).focus();
    await user.keyboard("{Enter}{Shift>}{F10}{/Shift}");
    expect(events).toContainEqual({ kind: "tableActivate", row: 50 });
    expect(itemMenu).toHaveBeenCalledWith("50");
    expect(screen.getByText("Inspect paged row")).toBeInTheDocument();
    hideContextMenu();
  });

  it.each([false, true])(
    "sends absolute row events and contributed context commands (sortable=%s)",
    async (sortable) => {
      const events: ViewEvent[] = [];
      const menuRun = vi.fn();
      const itemMenu = vi.fn((key: string) => [{ label: `Inspect ${key}`, run: menuRun }]);
      setPluginsBackend(
        backendWith(
          () => ({
            toolbar: [],
            status: null,
            body: {
              kind: "table",
              value: {
                columns: ["Route"],
                rows: [["/users"], ["/posts"]],
                totalRows: 2,
                firstRow: 0,
                editable: false,
                sortable,
                sort: null,
              },
            },
          }),
          events,
        ),
      );
      const user = userEvent.setup();
      render(
        <>
          <ContextMenuHost />
          <PluginView pluginId="jobs" view="routes" itemMenu={itemMenu} />
        </>,
      );
      const cell = await screen.findByText("/posts");
      await user.click(cell);
      expect(events).toContainEqual({ kind: "tableSelect", row: 1 });
      expect(cell.closest('[role="row"]')).toHaveAttribute("aria-selected", "true");
      await user.dblClick(cell);
      expect(events).toContainEqual({ kind: "tableActivate", row: 1 });
      const row = cell.closest('[role="row"]') as HTMLElement;
      row.focus();
      await user.keyboard("{Enter} ");
      expect(events.filter((e) => e.kind === "tableActivate")).toHaveLength(2);
      await user.pointer({ target: cell, keys: "[MouseRight]" });
      expect(itemMenu).toHaveBeenCalledWith("1");
      await user.click(screen.getByText("Inspect 1"));
      expect(menuRun).toHaveBeenCalledOnce();
      expect(screen.queryByText("Insert Row Above")).not.toBeInTheDocument();
      hideContextMenu();
    },
  );
});
