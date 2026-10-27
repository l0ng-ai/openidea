import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PluginInfo } from "@/bindings";
import { _setActiveEditor } from "@/editor/api";
import { executeAction, getAction } from "@/platform/actions";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { applyThemeAttributes, useThemeOverride } from "@/workbench/theme";
import { createMemoryPluginsBackend, sampleCatalog, setPluginsBackend, type PluginsBackend } from "../backend";
import {
  applyPluginTheme,
  applyTextToActiveEditor,
  PLUGIN_THEME_STYLE_ID,
  handlePluginEvent,
  pluginActionId,
  pluginActions,
  startPluginBridge,
} from "../bridge";
import { catalogState, filterCatalog, filterPlugins, NO_REPOSITORY, PluginsPage } from "../PluginsPage";
import {
  compareVersions,
  refreshPlugins,
  runPluginCommand,
  selectPluginTheme,
  setAllInstalledEnabled,
  setPluginEnabled,
  usePlugins,
} from "../store";

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];
let backend: PluginsBackend;
let view: EditorView | null = null;

function plugin(partial: Partial<PluginInfo> & Pick<PluginInfo, "id">): PluginInfo {
  return {
    name: partial.id,
    version: "1.0.0",
    description: "",
    authors: [],
    homepage: null,
    changeNotes: null,
    source: "installed",
    path: `/plugins/${partial.id}`,
    enabled: true,
    status: "active",
    error: null,
    hasCode: true,
    permissions: [],
    commands: [],
    languages: [],
    themes: [],
    ...partial,
  };
}

function editor(doc: string, anchor: number, head = anchor, readOnly = false) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  view = new EditorView({ state, parent: document.body });
  _setActiveEditor({ view, ctx: { doc: 1, path: "/p/a.txt", language: "plaintext", uiMode: null, readOnly } });
  return view;
}

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  backend = createMemoryPluginsBackend();
  setPluginsBackend(backend);
  usePlugins.setState({
    plugins: [],
    activeTheme: null,
    loaded: false,
    loading: false,
    error: null,
    busy: {},
    installing: false,
    catalog: null,
    catalogError: null,
  });
});

afterEach(() => {
  setPluginsBackend(null);
  _setActiveEditor(null);
  view?.destroy();
  view = null;
  applyPluginTheme(null);
});

describe("plugin actions", () => {
  it("maps commands of running plugins to plugin.<plugin>.<command> actions", () => {
    const actions = pluginActions([
      plugin({ id: "a", name: "Alpha", commands: [{ id: "go", title: "Alpha: Go", category: null }] }),
      plugin({ id: "b", status: "disabled", commands: [{ id: "x", title: "X", category: "Cat" }] }),
      plugin({ id: "c", status: "failed", commands: [{ id: "y", title: "Y", category: null }] }),
    ]);
    expect(actions.map((a) => a.id)).toEqual(["plugin.a.go"]);
    expect(actions[0]!.category).toBe("Alpha");
    expect(pluginActionId("p", "c.d")).toBe("plugin.p.c.d");
  });

  it("keeps the registry in sync and runs commands through the backend", async () => {
    const stop = startPluginBridge();
    await refreshPlugins();
    expect(getAction("plugin.hello.insert-date")?.title).toBe("Hello: Insert Date");
    expect(getAction("plugin.hello.word-count")).toBeDefined();

    const v = editor("ab", 1);
    await act(() => executeAction("plugin.hello.insert-date"));
    expect(v.state.doc.toString()).toMatch(/^a\d{4}-\d{2}-\d{2}b$/);

    await setPluginEnabled("hello", false);
    expect(getAction("plugin.hello.insert-date")).toBeUndefined();
    stop();
  });
});

describe("store", () => {
  it("reports command failures, but not twice for plugins that trapped", async () => {
    await refreshPlugins();
    await runPluginCommand("hello", "word-count");
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Hello: Word Count of Active File failed" });

    notes = [];
    const failing: PluginsBackend = {
      ...backend,
      runCommand: async () => {
        throw new Error("trapped");
      },
      list: async () => {
        const snap = await backend.list();
        return {
          ...snap,
          plugins: snap.plugins.map((p) => (p.id === "hello" ? { ...p, status: "failed" as const } : p)),
        };
      },
    };
    setPluginsBackend(failing);
    await runPluginCommand("hello", "insert-date");
    expect(notes).toEqual([]);
  });

  it("selects and clears a plugin theme", async () => {
    await refreshPlugins();
    await selectPluginTheme("theme-solarized-dark", "solarized-dark");
    expect(usePlugins.getState().activeTheme?.theme.id).toBe("solarized-dark");
    await selectPluginTheme(null, null);
    expect(usePlugins.getState().activeTheme).toBeNull();
  });

  it("filters by name, id, author and command title", () => {
    const list = [
      plugin({ id: "a", name: "Alpha", commands: [{ id: "c", title: "Count Words", category: null }] }),
      plugin({ id: "b", name: "Beta", authors: ["Zed"] }),
    ];
    expect(filterPlugins(list, "count").map((p) => p.id)).toEqual(["a"]);
    expect(filterPlugins(list, "zed").map((p) => p.id)).toEqual(["b"]);
    expect(filterPlugins(list, " ")).toHaveLength(2);
  });
});

describe("bridge events", () => {
  it("applies theme tokens as a stylesheet and removes it again", () => {
    const root = document.documentElement;
    const sheet = () => document.getElementById(PLUGIN_THEME_STYLE_ID)?.textContent ?? null;
    applyPluginTheme({
      pluginId: "p",
      theme: { id: "t", name: "T", kind: "dark", tokens: { "--bg-app": "#002b36", "--evil": "red; x: y", bad: "1" } },
    });
    expect(sheet()).toContain("--bg-app: #002b36;");
    expect(sheet()).toContain("color-scheme: dark;");
    expect(sheet()).not.toContain("evil");
    expect(sheet()).not.toContain("bad");
    expect(root.dataset.pluginTheme).toBe("p/t");
    applyPluginTheme(null);
    expect(sheet()).toBeNull();
    expect(root.dataset.pluginTheme).toBeUndefined();
  });

  it("switches the built-in base to the theme's kind and restores it", () => {
    const root = document.documentElement;
    useThemeOverride.setState({ theme: "dark-hc" });
    applyThemeAttributes("dark-hc", root);
    expect([root.dataset.theme, root.dataset.contrast]).toEqual(["dark", "high"]);
    applyPluginTheme({ pluginId: "p", theme: { id: "l", name: "L", kind: "light", tokens: { "--accent": "#123456" } } });
    expect([root.dataset.theme, root.dataset.contrast]).toEqual(["light", undefined]);
    expect(root.dataset.pluginThemeKind).toBe("light");
    // The appearance runtime re-applying the built-in theme keeps the plugin's base.
    applyThemeAttributes("dark-hc", root);
    expect(root.dataset.theme).toBe("light");
    applyPluginTheme(null);
    expect([root.dataset.theme, root.dataset.contrast]).toEqual(["dark", "high"]);
    expect(root.dataset.pluginThemeKind).toBeUndefined();
    useThemeOverride.setState({ theme: null });
  });

  it("inserts at the cursor and replaces selections", () => {
    const v = editor("hello world", 6, 11);
    handlePluginEvent({ type: "replaceSelection", pluginId: "p", text: "there" });
    expect(v.state.doc.toString()).toBe("hello there");
    expect(v.state.selection.main).toMatchObject({ from: 6, to: 11 });
    handlePluginEvent({ type: "insertText", pluginId: "p", text: "!" });
    expect(v.state.doc.toString()).toBe("hello !");
    expect(v.state.selection.main.head).toBe(7);
  });

  it("warns instead of editing read-only or missing editors", () => {
    expect(applyTextToActiveEditor("x", false, "p")).toBe(false);
    const v = editor("abc", 0, 0, true);
    expect(applyTextToActiveEditor("x", false, "p")).toBe(false);
    expect(v.state.doc.toString()).toBe("abc");
    expect(notes.map((n) => n.level)).toEqual(["warning", "warning"]);
  });

  it("shows plugin notifications and tracks theme changes", () => {
    handlePluginEvent({ type: "notification", pluginId: "p", level: "info", title: "Done", body: "3 words" });
    expect(notes).toEqual([{ group: "plugins", level: "info", title: "Done", body: "3 words" }]);
    handlePluginEvent({ type: "themeChanged", theme: null });
    expect(usePlugins.getState().activeTheme).toBeNull();
  });
});

describe("PluginsPage", () => {
  it("lists plugins, shows details, toggles and applies themes", async () => {
    const user = userEvent.setup();
    render(<PluginsPage />);
    const list = await screen.findByRole("list", { name: "Installed plugins" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));

    // Sorted as returned; first one selected by default.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Hello");
    expect(screen.getByText("plugin.hello.insert-date")).toBeInTheDocument();
    expect(screen.getByText("Insert text into the active editor")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Disable Hello" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable Hello" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Run Hello: Insert Date" })).toBeDisabled();

    await user.click(within(list).getByText("Solarized Dark Theme"));
    await user.click(screen.getByRole("button", { name: "Apply theme Solarized Dark" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Theme" })).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter plugins"), "toy");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Toy Language");
    expect(screen.getByText(".toy")).toBeInTheDocument();
  });

  it("restarts a failed plugin instead of disabling it", async () => {
    setPluginsBackend(createMemoryPluginsBackend([plugin({ id: "broken", status: "failed", error: "trap" })]));
    const user = userEvent.setup();
    render(<PluginsPage />);
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(usePlugins.getState().plugins[0]).toMatchObject({ enabled: true, status: "active" }));
  });

  it("uninstalls after confirmation", async () => {
    const user = userEvent.setup();
    render(<PluginsPage />);
    await screen.findByRole("heading", { level: 2 });
    await user.click(screen.getByRole("button", { name: "Uninstall…" }));
    await user.click(screen.getByRole("button", { name: "Confirm uninstall Hello" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).not.toHaveTextContent("Hello"));
    expect(notes.at(-1)).toMatchObject({ title: "Uninstalled Hello" });
  });

  it("shows What's New from the change notes", async () => {
    const user = userEvent.setup();
    setPluginsBackend(
      createMemoryPluginsBackend([plugin({ id: "hello", name: "Hello", changeNotes: "Added word count." })]),
    );
    render(<PluginsPage />);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.queryByText("Added word count.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "What's New" }));
    expect(screen.getByText("Added word count.")).toBeInTheDocument();
  });

  it("installs from the local catalog on the Available tab", async () => {
    const user = userEvent.setup();
    const catalog = sampleCatalog();
    setPluginsBackend(createMemoryPluginsBackend([], catalog));
    render(<PluginsPage />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    expect(within(list).getByText(new RegExp(NO_REPOSITORY))).toBeInTheDocument();
    await waitFor(() => expect(within(list).getByText("Toy Language")).toBeInTheDocument());
    await user.click(within(list).getByText("Toy Language"));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Toy Language");
    await user.click(screen.getAllByRole("button", { name: "Install Toy Language" })[0]!);
    await waitFor(() => expect(usePlugins.getState().plugins.map((p) => p.id)).toEqual(["language-toy"]));
    expect(within(list).getAllByText("Installed").length).toBeGreaterThan(0);
    expect(notes.at(-1)).toMatchObject({ title: "Installed Toy Language 0.1.0" });
  });
});

describe("catalog helpers", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.2")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0-beta", "0.2.0")).toBe(-1);
  });

  it("derives install / update / installed / dev states", () => {
    const entry = sampleCatalog().find((c) => c.id === "hello")!;
    expect(catalogState(entry, [])).toBe("install");
    expect(catalogState(entry, [plugin({ id: "hello", version: "0.0.9" })])).toBe("update");
    expect(catalogState(entry, [plugin({ id: "hello", version: "0.1.0" })])).toBe("installed");
    expect(catalogState(entry, [plugin({ id: "hello", source: "dev" })])).toBe("dev");
    expect(filterCatalog(sampleCatalog(), "solarized").map((c) => c.id)).toEqual(["theme-solarized-dark"]);
  });

  it("disables and re-enables all downloaded plugins, leaving dev plugins alone", async () => {
    setPluginsBackend(
      createMemoryPluginsBackend([plugin({ id: "a" }), plugin({ id: "b" }), plugin({ id: "d", source: "dev" })]),
    );
    await refreshPlugins();
    expect(await setAllInstalledEnabled(false)).toBe(2);
    const enabled = () => Object.fromEntries(usePlugins.getState().plugins.map((p) => [p.id, p.enabled]));
    expect(enabled()).toEqual({ a: false, b: false, d: true });
    expect(await setAllInstalledEnabled(true)).toBe(2);
    expect(enabled()).toEqual({ a: true, b: true, d: true });
  });
});
