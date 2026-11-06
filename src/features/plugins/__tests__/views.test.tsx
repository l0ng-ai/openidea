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
import { FRAME_CSP, FRAME_TAG, frameDocument, frameTheme, type FrameTheme } from "../views/frame";
import { PluginView, treeNodes, wantedViewport } from "../views/PluginView";
import { bumpView } from "../views/viewStore";
import { ToolWindowShownProvider } from "@/workbench/contributions";

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
    render(<PluginView pluginId="jobs" view="jobs" label="Jobs" />);
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

describe("tabs, text and process bodies", () => {
  const process = {
    program: "kubectl",
    args: ["logs", "x"],
    toggles: [{ id: "ts", label: "Timestamps", args: ["--timestamps"] }],
  };
  const tabs: View = {
    toolbar: [],
    status: null,
    body: {
      kind: "tabs",
      value: [
        { id: "log", label: "Log", body: { kind: "process", value: process } },
        { id: "inspect", label: "Inspect", body: { kind: "text", value: "a: 1" } },
      ],
    },
  };

  function streaming(view: View) {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const backend = {
      ...backendWith(() => view),
      streamProcess: vi.fn<PluginsBackend["streamProcess"]>(() => {
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      }),
    };
    setPluginsBackend(backend);
    return { backend, stops };
  }

  it("switches tabs without calling the plugin", async () => {
    const { backend } = streaming(tabs);
    const user = userEvent.setup();
    render(<PluginView pluginId="kube" view="pods/pod:a" />);
    await user.click(await screen.findByRole("tab", { name: "Inspect" }));
    expect(screen.getByRole("document").textContent).toBe("a: 1");
    expect(backend.renderView).toHaveBeenCalledTimes(1);
    expect(backend.viewEvent).not.toHaveBeenCalled();
  });

  it("shows text as a selectable document", async () => {
    streaming({ toolbar: [], status: null, body: { kind: "text", value: "Name: nginx" } });
    render(<PluginView pluginId="kube" view="pods/pod:a" />);
    expect((await screen.findByRole("document")).textContent).toBe("Name: nginx");
  });

  it("streams a process body through the backend and restarts it on a toggle", async () => {
    const { backend, stops } = streaming(tabs);
    const user = userEvent.setup();
    const { unmount } = render(<PluginView pluginId="kube" view="pods/pod:a" />);
    await waitFor(() => expect(backend.streamProcess).toHaveBeenCalledTimes(1));
    expect(backend.streamProcess.mock.calls[0]).toEqual([
      "kube",
      "pods/pod:a",
      process,
      new Set(),
      expect.any(Function),
      expect.any(Function),
    ]);
    await user.click(screen.getByRole("switch", { name: "Timestamps" }));
    expect(backend.streamProcess).toHaveBeenCalledTimes(2);
    expect(backend.streamProcess.mock.calls[1]?.[3]).toEqual(new Set(["ts"]));
    expect(stops.at(0)).toHaveBeenCalled();
    unmount();
    expect(stops.at(1)).toHaveBeenCalled();
  });
  it("stops the program while its tool window is hidden", async () => {
    const { backend, stops } = streaming({ toolbar: [], status: null, body: { kind: "process", value: process } });
    const view = (shown: boolean) => (
      <ToolWindowShownProvider value={shown}>
        <PluginView pluginId="kube" view="pods" />
      </ToolWindowShownProvider>
    );
    const { rerender } = render(view(true));
    await waitFor(() => expect(backend.streamProcess).toHaveBeenCalledTimes(1));
    rerender(view(false));
    expect(stops.at(0)).toHaveBeenCalled();
    rerender(view(true));
    expect(backend.streamProcess).toHaveBeenCalledTimes(2);
  });
});
