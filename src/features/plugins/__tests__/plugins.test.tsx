import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Consent, InstallPreview, MarketPlugin, PluginInfo, ProjectInfo } from "@/bindings";
import { _setActiveEditor } from "@/editor/api";
import { executeAction, executeActionFrom, getAction, registerAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { pluginThemeRef, useContributedIconThemes } from "@/platform/themes";
import { ContextMenuHost, hideContextMenu } from "@/ui";
import { InputDialogsHost } from "@/workbench/inputDialogs";
import { MessagesHost } from "@/workbench/messages";
import {
  onEndpointsChanged,
  provideNotificationService,
  searchEndpoints,
  type NotificationService,
} from "@/workbench/contributions";
import { applyThemeAttributes, previewTheme, useThemeOverride } from "@/workbench/theme";
import { createMemoryPluginsBackend, sampleCatalog, setPluginsBackend, type PluginsBackend } from "../backend";
import {
  applyPluginTheme,
  followThemeSetting,
  PLUGIN_THEME_STYLE_ID,
  handlePluginEvent,
  providePluginThemePreviews,
  pluginActionId,
  startPluginBridge,
  syncProjection,
} from "../bridge";
import { iconResolver, selectedIconTheme, useIconThemes } from "../iconThemes";
import { markerIcon, placeMarkers } from "../lineMarkerGutter";
import { SecretsDetails } from "../secrets";
import { handleRuntimeEvent, startRuntimeUi, usePluginStatusItems } from "../runtimeUi";
import { evaluateWhen, getContext } from "@/platform/context";
import { useTasks } from "@/workbench/tasks";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, defineUiPoint, syncUiContributions } from "../projection";
import { catalogState, filterCatalog, filterPlugins, NO_REPOSITORY, PluginsPage } from "../PluginsPage";
import { ConsentDialogHost, provideConsentDialog } from "../consent";
import {
  adoptIconTheme,
  compareVersions,
  installFromDisk,
  updateAllPlugins,
  refreshPlugins,
  runPluginCommand,
  selectPluginTheme,
  setAllInstalledEnabled,
  setConsentPrompt,
  setPluginEnabled,
  usePlugins,
  type ConsentRequest,
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
    icon: null,
    source: "installed",
    path: `/plugins/${partial.id}`,
    enabled: true,
    status: "active",
    error: null,
    hasCode: true,
    capabilities: [],
    netHosts: [],
    contributions: [],
    activation: [],
    warnings: [],
    stats: {
      activations: 0,
      activationMs: 0,
      calls: 0,
      errors: 0,
      maxCallMs: 0,
      p95CallMs: 0,
      slowCalls: 0,
      crashes: 0,
      reclaims: 0,
    },
    publisher: null,
    previousVersion: null,
    depends: [],
    dependents: [],
    extensionPoints: [],
    ...partial,
  };
}

function editor(doc: string, anchor: number, head = anchor, readOnly = false) {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  view = new EditorView({ state, parent: document.body });
  _setActiveEditor({ view, ctx: { doc: 1, path: "/p/a.txt", language: "plaintext", uiMode: null, readOnly } });
  return view;
}

let undefinePoints: () => void = () => {};

beforeEach(() => {
  undefinePoints = defineBuiltinUiPoints();
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  backend = createMemoryPluginsBackend();
  setPluginsBackend(backend);
  usePlugins.setState({
    plugins: [],
    ui: [],
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
  clearUiContributions();
  undefinePoints();
  setConsentPrompt(null);
  setPluginsBackend(null);
  _setActiveEditor(null);
  view?.destroy();
  view = null;
  applyPluginTheme(null);
});

describe("plugin actions", () => {
  it("names manual and provider inspection producers after their plugin", async () => {
    const { useProducerNames } = await import("@/platform/inspections");
    usePlugins.setState({ plugins: [plugin({ id: "a", name: "Alpha" })] });
    const stop = syncProjection();
    expect(useProducerNames.getState().names.get("plugin:a")).toBe("Alpha");
    expect(useProducerNames.getState().names.get("plugin-provider:a")).toBe("Alpha");
    stop();
  });

  it("projects command contributions to plugin.<plugin>.<command> actions", () => {
    const cmd = (pluginId: string, id: string, extra: Record<string, unknown> = {}) => ({
      pluginId,
      point: "commands",
      key: id,
      decl: { id, title: `T ${id}`, ...extra },
    });
    syncUiContributions(
      [cmd("a", "go"), cmd("a", "when", { when: "editorFocus", category: "Cat" }), cmd("gone", "x")],
      [plugin({ id: "a", name: "Alpha" })],
    );
    expect(getAction("plugin.a.go")).toMatchObject({ title: "T go", category: "Alpha", indicatesRunning: true });
    expect(getAction("plugin.a.when")).toMatchObject({ when: "editorFocus", category: "Cat" });
    expect(getAction("plugin.gone.x")).toBeUndefined();
    expect(pluginActionId("p", "c.d")).toBe("plugin.p.c.d");
    // Changed declarations are re-projected; removed ones disposed.
    syncUiContributions([cmd("a", "go", { title: "Renamed" })], [plugin({ id: "a", name: "Alpha" })]);
    expect(getAction("plugin.a.go")?.title).toBe("Renamed");
    expect(getAction("plugin.a.when")).toBeUndefined();
  });

  it("isolates a failing projection (a defect) from the other items", () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    const live: string[] = [];
    const undefine = defineUiPoint<{ n: number }>("test.items", {
      project: ({ decl }) => {
        if (decl.n === 2) throw new Error("bug");
        live.push(String(decl.n));
        return () => live.splice(live.indexOf(String(decl.n)), 1);
      },
    });
    const item = (n: number) => ({ pluginId: "a", point: "test.items", key: String(n), decl: { n } });
    syncUiContributions([item(1), item(2), item(3)], [plugin({ id: "a" })]);
    expect(live).toEqual(["1", "3"]);
    expect(errors).toHaveLength(1);
    undefine();
    expect(live).toEqual([]);
    console.error = original;
  });

  it("keeps the registry in sync and runs commands through the backend", async () => {
    // The bridge defines the points itself (main window).
    undefinePoints();
    undefinePoints = () => {};
    const stop = startPluginBridge();
    await refreshPlugins();
    expect(getAction("plugin.hello.insert-date")?.title).toBe("Hello: Insert Date");
    expect(getAction("plugin.hello.word-count")).toBeDefined();

    // Edits come back as document patches; here the command's result shows it ran.
    const ran: unknown[] = [];
    const run = backend.runCommand;
    backend.runCommand = async (...args) => {
      const out = await run(...args);
      ran.push(out);
      return out;
    };
    editor("ab", 1);
    await act(() => executeAction("plugin.hello.insert-date"));
    expect(ran).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]);

    await setPluginEnabled("hello", false);
    expect(getAction("plugin.hello.insert-date")).toBeUndefined();
    stop();
  });

  it("reports actions to on-event:action-performed plugins once the project opens and when plugins change", async () => {
    // Like `authorize_command`: refused until the window's project is open and trusted.
    let kinds: Awaited<ReturnType<PluginsBackend["eventKinds"]>> = [];
    const posted: unknown[] = [];
    setPluginsBackend({
      ...backend,
      eventKinds: async () => {
        if (!useProject.getState().project?.trusted) throw new Error("no project is open in this window");
        return kinds;
      },
      postEvents: async (events) => void posted.push(...events),
    });
    const offAction = registerAction({ id: "test.columnMode", title: "Column Mode", run: () => {} });
    const performed = (n: number) =>
      Array.from({ length: n }, () => ({
        kind: "actionPerformed",
        value: { action: "test.columnMode", title: "Column Mode", source: "menu", shortcut: null },
      }));
    undefinePoints();
    undefinePoints = () => {};
    kinds = ["action-performed"];
    const stop = startPluginBridge();
    try {
      // Asked at startup, before the project is open: refused.
      await new Promise((r) => setTimeout(r, 20));
      await executeActionFrom("menu", "test.columnMode");
      await new Promise((r) => setTimeout(r, 600));
      expect(posted).toEqual([]);

      useProject.setState({ project: { root: "/p", trusted: true } as never });
      await new Promise((r) => setTimeout(r, 20));
      await executeActionFrom("menu", "test.columnMode");
      await waitFor(() => expect(posted).toEqual(performed(1)));

      // Declared kinds change with the installed plugins (`commandsChanged`).
      kinds = [];
      handlePluginEvent({ type: "commandsChanged" });
      await new Promise((r) => setTimeout(r, 60));
      await executeActionFrom("menu", "test.columnMode");
      kinds = ["action-performed"];
      handlePluginEvent({ type: "commandsChanged" });
      await new Promise((r) => setTimeout(r, 60));
      await executeActionFrom("menu", "test.columnMode");
      await waitFor(() => expect(posted).toEqual(performed(2)));
    } finally {
      stop();
      offAction();
      useProject.setState({ project: null });
    }
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
    await selectPluginTheme("theme-harbor-night", "harbor-night");
    expect(usePlugins.getState().activeTheme?.theme.id).toBe("harbor-night");
    await selectPluginTheme(null, null);
    expect(usePlugins.getState().activeTheme).toBeNull();
  });

  it("applies the plugin theme the Appearance setting selects, and clears it for a built-in one", async () => {
    const stop = [syncProjection(), followThemeSetting()];
    try {
      useProject.setState({ settings: { appearance: { theme: "plugin:theme-harbor-night/harbor-night" } } as never });
      await refreshPlugins();
      await waitFor(() => expect(usePlugins.getState().activeTheme?.theme.id).toBe("harbor-night"));
      // A built-in theme picked anywhere (here the session override) wins over it.
      act(() => useThemeOverride.setState({ theme: "solarized-dark" }));
      await waitFor(() => expect(usePlugins.getState().activeTheme).toBeNull());
      act(() => useThemeOverride.setState({ theme: null }));
      await waitFor(() => expect(usePlugins.getState().activeTheme?.theme.id).toBe("harbor-night"));
    } finally {
      stop.forEach((s) => s());
      useThemeOverride.setState({ theme: null });
      useProject.setState({ settings: null as never });
    }
  });

  it("leaves a theme another window selected alone until this window's settings change", async () => {
    const stop = [syncProjection(), followThemeSetting()];
    try {
      useProject.setState({ settings: { appearance: { theme: "plugin:theme-harbor-night/harbor-night" } } as never });
      await refreshPlugins();
      await waitFor(() => expect(usePlugins.getState().activeTheme?.theme.id).toBe("harbor-night"));
      const setTheme = vi.spyOn(backend, "setTheme");
      // Another window picked a built-in theme; this window's settings still name the plugin's.
      act(() => usePlugins.setState({ activeTheme: null }));
      await Promise.resolve();
      expect(setTheme).not.toHaveBeenCalled();
      act(() => useProject.setState({ settings: { appearance: { theme: "dark" } } as never }));
      expect(setTheme).not.toHaveBeenCalled();
    } finally {
      stop.forEach((s) => s());
      useProject.setState({ settings: null as never });
    }
  });

  it("installs from a folder, its plugin.toml, or a package file unpacked first", async () => {
    setConsentPrompt(async () => ({ optional: [] }));
    for (const [picked, unpacked] of [
      ["plugins/hello", null],
      ["plugins/hello/plugin.toml", null],
      ["C:\\plugins\\hello\\Plugin.TOML", null],
      ["/downloads/hello.zip", "/downloads/hello.zip"],
      ["/downloads/hello-1.0.0.oiplugin", "/downloads/hello-1.0.0.oiplugin"],
    ] as const) {
      const unpack = vi.fn(async () => "plugins/hello");
      const preview = vi.fn();
      const backend = createMemoryPluginsBackend([], sampleCatalog());
      setPluginsBackend({
        ...backend,
        unpackPackage: unpack,
        previewInstall: (path) => {
          preview(path);
          return backend.previewInstall("plugins/hello");
        },
        installDir: (_path, consent) => backend.installDir("plugins/hello", consent),
      });
      expect(await installFromDisk(picked)).toBe("hello");
      expect(unpack.mock.calls).toEqual(unpacked ? [[unpacked]] : []);
      const folder = unpacked ? "plugins/hello" : picked.replace(/[\\/]plugin\.toml$/i, "");
      expect(preview).toHaveBeenCalledWith(folder);
      usePlugins.setState({ plugins: [] });
    }
  });

  it("asks for consent before installing and passes the answer on", async () => {
    const asked: ConsentRequest[] = [];
    setConsentPrompt(async (req) => {
      asked.push(req);
      return { optional: [] };
    });
    setPluginsBackend(createMemoryPluginsBackend([], sampleCatalog()));
    expect(await installFromDisk("plugins/hello")).toBe("hello");
    expect(asked[0]).toMatchObject({ pluginId: "hello", kind: "install", unsigned: true });
    expect(asked[0]!.capabilities.map((c) => c.id)).toContain("editor.write");

    setConsentPrompt(async () => null);
    setPluginsBackend(createMemoryPluginsBackend([], sampleCatalog()));
    expect(await installFromDisk("plugins/hello")).toBeNull();
    expect(usePlugins.getState().plugins).toEqual([]);
  });

  it("filters by name, id, author and contribution", () => {
    const list = [
      plugin({ id: "a", name: "Alpha", contributions: [{ point: "commands", label: "Count Words" }] }),
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
    applyPluginTheme({
      pluginId: "p",
      theme: { id: "l", name: "L", kind: "light", tokens: { "--accent": "#123456" } },
    });
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

  it("previews a live plugin's theme in this window without selecting it", () => {
    const root = document.documentElement;
    const sheet = () => document.getElementById(PLUGIN_THEME_STYLE_ID)?.textContent ?? null;
    const setTheme = vi.spyOn(backend, "setTheme");
    const night = { id: "night", name: "Night", kind: "dark", tokens: { "--bg-app": "#101820" } };
    const dawn = { id: "dawn", name: "Dawn", kind: "light" as const, tokens: { "--bg-app": "#fff8e7" } };
    usePlugins.setState({
      ui: [{ pluginId: "acme", point: "themes", key: "night", decl: night }],
      activeTheme: { pluginId: "acme", theme: dawn },
    });
    applyPluginTheme(usePlugins.getState().activeTheme);
    const stop = providePluginThemePreviews();

    previewTheme(pluginThemeRef("acme", "night"));
    expect(sheet()).toContain("--bg-app: #101820;");
    expect([root.dataset.pluginTheme, root.dataset.theme]).toEqual(["acme/night", "dark"]);
    // A built-in theme shows without the plugin's tokens.
    previewTheme("solarized-light");
    expect(sheet()).toBeNull();
    expect([root.dataset.theme, root.dataset.colorTheme]).toEqual(["light", "solarized-light"]);
    // Back to the selected one; nothing was selected on the way.
    previewTheme(null);
    expect(sheet()).toContain("--bg-app: #fff8e7;");
    expect(root.dataset.pluginTheme).toBe("acme/dawn");
    expect(setTheme).not.toHaveBeenCalled();

    stop();
    applyPluginTheme(null);
  });

  it("runs commands with the focused editor's path, language and UTF-16 selections", async () => {
    const calls: unknown[] = [];
    setPluginsBackend({
      ...backend,
      runCommand: async (...args) => {
        calls.push(args);
        return null;
      },
    });
    editor("ab\n😀cd", 3, 7);
    await runPluginCommand("p", "c");
    expect(calls).toEqual([
      [
        "p",
        "c",
        null,
        {
          path: "/p/a.txt",
          language: "plaintext",
          selections: [{ start: { line: 1, col: 0 }, end: { line: 1, col: 4 } }],
        },
        [],
      ],
    ]);
  });

  it("forwards a menu's path and selection to the command", async () => {
    const calls: unknown[][] = [];
    setPluginsBackend({
      ...backend,
      runCommand: async (...args) => {
        calls.push(args);
        return null;
      },
    });
    undefinePoints();
    undefinePoints = () => {};
    const stop = startPluginBridge();
    await refreshPlugins();
    await act(() =>
      executeAction("plugin.hello.insert-date", { path: "/p/a.java", paths: ["/p/a.java", "/p/b.java"] }),
    );
    expect(calls[0]?.[2]).toBe("/p/a.java");
    expect(calls[0]?.[4]).toEqual(["/p/a.java", "/p/b.java"]);
    stop();
  });

  it("shows status items and tasks of running plugin code", () => {
    const item = { text: "main ↑1", tooltip: "Branch", command: "refresh" };
    handlePluginEvent({ type: "statusItemChanged", pluginId: "git", id: "branch", item });
    expect(usePluginStatusItems.getState().items.get("git/branch")).toEqual({ pluginId: "git", item });
    handlePluginEvent({ type: "statusItemChanged", pluginId: "git", id: "branch", item: null });
    expect(usePluginStatusItems.getState().items.size).toBe(0);

    handlePluginEvent({ type: "taskStarted", pluginId: "git", taskId: "7", title: "Fetching", cancellable: true });
    handlePluginEvent({ type: "taskProgress", pluginId: "git", taskId: "7", done: 1, total: 4, message: "origin" });
    const task = useTasks.getState().tasks.find((t) => t.id === "plugin:7")!;
    expect([task.title, task.fraction, task.message, !!task.cancel]).toEqual(["Fetching", 0.25, "origin", true]);
    handlePluginEvent({ type: "taskEnded", pluginId: "git", taskId: "7" });
    expect(useTasks.getState().tasks.find((t) => t.id === "plugin:7")?.done).toBe(true);
  });

  it("keeps a window status override above global updates and falls back on removal", () => {
    const global = { text: "global", tooltip: null, command: null };
    const local = { text: "window", tooltip: null, command: null };
    handleRuntimeEvent({ type: "statusItemChanged", pluginId: "scope", id: "state", item: global });
    handleRuntimeEvent({ type: "windowStatusItemChanged", pluginId: "scope", id: "state", item: local });
    handleRuntimeEvent({
      type: "statusItemChanged",
      pluginId: "scope",
      id: "state",
      item: { ...global, text: "updated" },
    });
    expect(usePluginStatusItems.getState().items.get("scope/state")?.item.text).toBe("window");
    handleRuntimeEvent({ type: "windowStatusItemChanged", pluginId: "scope", id: "state", item: null });
    expect(usePluginStatusItems.getState().items.get("scope/state")?.item.text).toBe("updated");
    handleRuntimeEvent({ type: "statusItemChanged", pluginId: "scope", id: "state", item: null });
  });

  it("executes host command requests through actions and returns plugin command results", async () => {
    const answerCommand = vi.fn().mockResolvedValue(undefined);
    const runCommand = vi.fn().mockResolvedValue("plugin result");
    setPluginsBackend({ ...backend, answerCommand, runCommand });
    const run = vi.fn();
    const dispose = registerAction({ id: "test.host-command", title: "Test", run });
    try {
      handleRuntimeEvent({
        type: "executeCommand",
        requestId: "ide",
        id: "test.host-command",
        arg: "argument",
        chain: ["caller"],
      });
      await waitFor(() => expect(answerCommand).toHaveBeenCalledWith("ide", { kind: "value", value: null }));
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ arg: "argument" }));
      usePlugins.setState({
        ui: [{ pluginId: "other", point: "commands", key: "test", decl: { id: "test", title: "Test" } }],
      });
      handleRuntimeEvent({
        type: "executeCommand",
        requestId: "plugin",
        id: "plugin.other.test",
        arg: "argument",
        chain: ["caller"],
      });
      await waitFor(() =>
        expect(answerCommand).toHaveBeenCalledWith("plugin", { kind: "value", value: "plugin result" }),
      );
      expect(runCommand).toHaveBeenCalledWith("other", "test", "argument", null, [], undefined, ["caller"]);
      handleRuntimeEvent({ type: "executeCommand", requestId: "missing", id: "unknown", arg: null, chain: ["caller"] });
      await waitFor(() => expect(answerCommand).toHaveBeenCalledWith("missing", { kind: "notFound" }));
    } finally {
      dispose();
    }
  });

  it("runs notification buttons as commands of the publishing plugin with their arguments", async () => {
    const runCommand = vi.fn().mockResolvedValue(null);
    setPluginsBackend({ ...backend, runCommand });
    handlePluginEvent({
      type: "notification",
      pluginId: "hello",
      level: "info",
      title: "Done",
      body: "Pick an action",
      actions: [
        { label: "Open", command: "insert-date", argument: "first\nsecond" },
        { label: "Refresh", command: "word-count", argument: null },
        { label: "Undo", command: "insert-date", argument: "undo" },
      ],
    });
    expect(notes[0]?.actions?.map((a) => a.label)).toEqual(["Open", "Refresh", "Undo"]);
    notes[0]!.actions![0]!.run();
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith("hello", "insert-date", "first\nsecond", null, []));
  });

  it("shows plugin notifications, copies to clipboard, opens URLs and tracks theme changes", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    handlePluginEvent({
      type: "notification",
      pluginId: "p",
      level: "info",
      title: "Done",
      body: "3 words",
      actions: [],
    });
    expect(notes).toEqual([
      { group: "plugins", level: "info", title: "Done", body: "3 words", verbatim: true, actions: [] },
    ]);
    handlePluginEvent({ type: "copyToClipboard", pluginId: "p", text: "https://github.com/o/r" });
    expect(writeText).toHaveBeenCalledWith("https://github.com/o/r");
    handlePluginEvent({ type: "openUrl", pluginId: "p", url: "https://github.com/o/r/blob/main/a.rs" });
    expect(open).toHaveBeenCalledWith("https://github.com/o/r/blob/main/a.rs", "_blank", "noopener");
    open.mockRestore();
    handlePluginEvent({ type: "themeChanged", theme: null });
    expect(usePlugins.getState().activeTheme).toBeNull();
  });
});

describe("plugin prompts", () => {
  it("shows a plugin's question and reports the answer or the dismissal", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<InputDialogsHost />);

    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "1",
        prompt: {
          kind: "quickPick",
          title: "Pick targets",
          multiple: true,
          items: [
            { key: "a", label: "Alpha", description: null },
            { key: "b", label: "Beta", description: "second" },
          ],
        },
      });
    });
    await user.click(await screen.findByRole("checkbox", { name: "Beta" }));
    await user.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("1", ["b"]));

    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "2",
        prompt: { kind: "input", prompt: "Name", value: "Main", multiline: false },
      });
    });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("2", null));
  });

  it("asks about a net:ask host with allow once, always allow and deny", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    usePlugins.setState({ plugins: [plugin({ id: "p", name: "Relay" })] });
    render(<MessagesHost />);

    const ask = (promptId: string) =>
      act(() => {
        handlePluginEvent({
          type: "promptRequested",
          pluginId: "p",
          promptId,
          prompt: { kind: "netPermission", host: "api.example.com", sessionOnly: false },
        });
      });
    ask("9");
    expect(screen.getByText("Allow Relay to connect to api.example.com?")).toBeDefined();
    expect(screen.getByText(/The host is not in the plugin's declared permissions\./)).toBeDefined();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("9", ["always"]));

    ask("10");
    await user.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("10", ["once"]));

    ask("11");
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("11", null));
  });

  it("offers session permission and deny for a remote net:ask prompt", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<MessagesHost />);
    const ask = (promptId: string) =>
      act(() => {
        handlePluginEvent({
          type: "promptRequested",
          pluginId: "p",
          promptId,
          prompt: { kind: "netPermission", host: "api.example.com", sessionOnly: true },
        });
      });
    ask("session-net");
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText(/This allows api.example.com until the remote session ends\./)).toBeDefined();
    expect(screen.queryByText(/revoke it any time/)).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Allow for this session" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("session-net", ["session"]));

    ask("denied-session-net");
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("denied-session-net", null));
  });

  it("refuses network prompts in a hidden window and closes them when hidden", async () => {
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<MessagesHost />);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const ask = (promptId: string) =>
      act(() => {
        handlePluginEvent({
          type: "promptRequested",
          pluginId: "p",
          promptId,
          prompt: { kind: "netPermission", host: "api.example.com", sessionOnly: false },
        });
      });
    try {
      visibility.mockReturnValue("hidden");
      ask("hidden");
      await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("hidden", null));
      expect(screen.queryByRole("dialog")).toBeNull();
      visibility.mockReturnValue("visible");
      ask("visible");
      expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
      visibility.mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("visible", null));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      visibility.mockRestore();
    }
  });

  it("dismisses a network prompt without allowing the request", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<MessagesHost />);
    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "dismissed-net",
        prompt: { kind: "netPermission", host: "api.example.com", sessionOnly: false },
      });
    });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("dismissed-net", null));
  });

  it("asks multi-line text and confirms on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<InputDialogsHost />);
    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "5",
        prompt: { kind: "input", prompt: "Notes", value: "one", multiline: true },
      });
    });
    const area = await screen.findByRole("textbox");
    expect(area.tagName).toBe("TEXTAREA");
    await user.clear(area);
    await user.type(area, "a{Enter}b{Control>}{Enter}{/Control}");
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("5", ["a\nb"]));
  });

  it("returns the typed text untrimmed", async () => {
    const user = userEvent.setup();
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<InputDialogsHost />);
    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "4",
        prompt: { kind: "input", prompt: "Name", value: "  Main  ", multiline: false },
      });
    });
    await user.click(await screen.findByRole("button", { name: "OK" }));
    await waitFor(() => expect(answerPrompt).toHaveBeenCalledWith("4", ["  Main  "]));
  });

  it("closes a question the plugin gave up on without answering", async () => {
    const answerPrompt = vi.fn().mockResolvedValue(undefined);
    setPluginsBackend({ ...createMemoryPluginsBackend(), answerPrompt });
    render(<InputDialogsHost />);
    act(() => {
      handlePluginEvent({
        type: "promptRequested",
        pluginId: "p",
        promptId: "3",
        prompt: { kind: "input", prompt: "Name", value: null, multiline: false },
      });
    });
    await screen.findByRole("dialog");
    act(() => handlePluginEvent({ type: "promptClosed", promptId: "3" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(answerPrompt).not.toHaveBeenCalled();
  });
});

describe("PluginsPage", () => {
  it("lists plugins, shows details, toggles and applies themes", async () => {
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    const list = await screen.findByRole("list", { name: "Installed plugins" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));

    // Sorted as returned; first one selected by default.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Hello");
    expect(screen.getByText("plugin.hello.insert-date")).toBeInTheDocument();
    expect(screen.getByText("Change text in the editor")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Disable Hello" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Enable Hello" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Run Hello: Insert Date" })).not.toBeInTheDocument();

    await user.click(within(list).getByText("Harbor Night Theme"));
    await user.click(screen.getByRole("button", { name: "Apply theme Harbor Night" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use Default Theme" })).toBeInTheDocument());

    await user.type(screen.getByLabelText("Filter plugins"), "toy");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Toy Language");
    expect(screen.getByText("Toy (.toy)")).toBeInTheDocument();
  });

  it("offers the IntelliJ theme imports only in a trusted project's window", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PluginsPage initialTab="installed" />
        <ContextMenuHost />
      </>,
    );
    const imports = async () => {
      await user.click(screen.getByRole("button", { name: "Manage Plugins" }));
      const found = ["Import Theme from JetBrains IDE…", "Import IntelliJ Theme from File…"].filter((name) =>
        screen.queryByRole("menuitem", { name }),
      );
      act(() => hideContextMenu());
      return found;
    };
    // The welcome screen: the host refuses installs without a trusted project.
    expect(await imports()).toEqual([]);
    const project = { trusted: false, root: "/p", name: "p", isGit: false } as unknown as ProjectInfo;
    act(() => useProject.setState({ project }));
    expect(await imports()).toEqual([]);
    act(() => useProject.setState({ project: { ...project, trusted: true } }));
    expect(await imports()).toHaveLength(2);
    act(() => useProject.setState({ project: null }));
  });

  it("shows a plugin's own icon in its row and details", async () => {
    const icon = { light: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>', dark: null };
    setPluginsBackend(createMemoryPluginsBackend([plugin({ id: "iconic", name: "Iconic", icon })]));
    render(<PluginsPage initialTab="installed" />);
    const list = await screen.findByRole("list", { name: "Installed plugins" });
    await waitFor(() => expect(within(list).getByText("Iconic")).toBeInTheDocument());
    expect(list.querySelector("circle")).not.toBeNull();
    expect(screen.getByLabelText("Iconic details").querySelector("circle")).not.toBeNull();
  });

  describe.each(["installed", "catalog"] as const)("%s homepage", (source) => {
    async function showHomepage(homepage: string) {
      const entry = plugin({ id: "homepage", name: "Homepage Example", homepage });
      const catalog = { ...sampleCatalog()[0]!, id: entry.id, name: entry.name, homepage };
      setPluginsBackend(createMemoryPluginsBackend(source === "installed" ? [entry] : [], [catalog]));
      const user = userEvent.setup();
      render(<PluginsPage initialTab="installed" />);
      if (source === "catalog") await user.click(screen.getByRole("tab", { name: /Available/ }));
      await screen.findByRole("heading", { level: 2, name: entry.name });
      return user;
    }

    it.each(["https://example.com/plugin", "http://example.com/plugin", "HTTPS://example.com/plugin"])(
      "opens a web homepage %s with a click or Enter",
      async (homepage) => {
        const open = vi.spyOn(window, "open").mockImplementation(() => null);
        try {
          const user = await showHomepage(homepage);
          const link = screen.getByRole("link", { name: homepage });
          expect(link).toHaveAttribute("href", homepage);
          await user.click(link);
          expect(open).toHaveBeenCalledWith(homepage, "_blank", "noopener");
          open.mockClear();
          link.focus();
          expect(link).toHaveFocus();
          await user.keyboard("{Enter}");
          expect(open).toHaveBeenCalledWith(homepage, "_blank", "noopener");
        } finally {
          open.mockRestore();
        }
      },
    );

    it.each(["not a URL", "https://", "/relative", "file:///tmp/plugin", "javascript:alert(1)", "mailto:a@b.com"])(
      "keeps an unsupported or malformed homepage %s as plain text",
      async (homepage) => {
        const open = vi.spyOn(window, "open").mockImplementation(() => null);
        try {
          const user = await showHomepage(homepage);
          expect(screen.queryByRole("link", { name: homepage })).not.toBeInTheDocument();
          await user.click(screen.getByText(homepage));
          expect(open).not.toHaveBeenCalled();
        } finally {
          open.mockRestore();
        }
      },
    );
  });

  it("restarts a failed plugin instead of disabling it", async () => {
    setPluginsBackend(createMemoryPluginsBackend([plugin({ id: "broken", status: "failed", error: "trap" })]));
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(usePlugins.getState().plugins[0]).toMatchObject({ enabled: true, status: "inactive" }));
  });

  it("uninstalls after confirmation", async () => {
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await screen.findByRole("heading", { level: 2 });
    await user.click(screen.getByRole("button", { name: "Uninstall…" }));
    await user.click(screen.getByRole("button", { name: "Confirm uninstall Hello" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).not.toHaveTextContent("Hello"));
    expect(notes.at(-1)).toMatchObject({ title: "Uninstalled Hello" });
  });

  it("keeps failed cleanup visible and lets Uninstall retry", async () => {
    const list = backend.list;
    const uninstall = backend.uninstall;
    let failed = false;
    vi.spyOn(backend, "list").mockImplementation(async () => {
      const snapshot = await list();
      if (failed) {
        snapshot.plugins = snapshot.plugins.map((p) =>
          p.id === "hello" ? { ...p, status: "failed", error: "Private data is locked" } : p,
        );
      }
      return snapshot;
    });
    const remove = vi.spyOn(backend, "uninstall").mockImplementation(async (id) => {
      if (!failed) {
        failed = true;
        throw new Error("Private data is locked");
      }
      await uninstall(id);
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await screen.findByRole("heading", { level: 2 });
    await user.click(screen.getByRole("button", { name: "Uninstall…" }));
    await user.click(screen.getByRole("button", { name: "Confirm uninstall Hello" }));
    await screen.findByText("Private data is locked");
    expect(notes.at(-1)).toMatchObject({
      level: "error",
      title: "Could not uninstall Hello",
      body: "Private data is locked",
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Hello");
    await user.click(screen.getByRole("button", { name: "Confirm uninstall Hello" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).not.toHaveTextContent("Hello"));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(notes.at(-1)).toMatchObject({ title: "Uninstalled Hello" });
  });

  it("shows What's New from the change notes", async () => {
    const user = userEvent.setup();
    setPluginsBackend(
      createMemoryPluginsBackend([plugin({ id: "hello", name: "Hello", changeNotes: "Added word count." })]),
    );
    render(<PluginsPage initialTab="installed" />);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.queryByText("Added word count.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "What's New" }));
    expect(screen.getByText("Added word count.")).toBeInTheDocument();
  });

  it("installs from the local catalog on the Available tab", async () => {
    const user = userEvent.setup();
    const catalog = sampleCatalog();
    setPluginsBackend(createMemoryPluginsBackend([], catalog));
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("Toy Language")).toBeInTheDocument());
    await user.click(within(list).getByText("Toy Language"));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Toy Language");
    await user.click(screen.getAllByRole("button", { name: "Install Toy Language" })[0]!);
    await waitFor(() => expect(usePlugins.getState().plugins.map((p) => p.id)).toEqual(["language-toy"]));
    expect(within(list).getAllByText("Installed").length).toBeGreaterThan(0);
    expect(notes.at(-1)).toMatchObject({ title: "Installed Toy Language 0.1.0" });
  });

  it("shows why the marketplace couldn't be read instead of claiming there is none", async () => {
    // Commands without a result type reject with the backend's error object, not an Error.
    setPluginsBackend({
      ...createMemoryPluginsBackend([], sampleCatalog()),
      marketUrl: () => Promise.reject({ kind: "unavailable", message: "Index unreachable", data: null }),
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    expect(await within(list).findByText("Index unreachable")).toBeInTheDocument();
    expect(within(list).queryByText("[object Object]")).not.toBeInTheDocument();
    expect(within(list).queryByText(new RegExp(NO_REPOSITORY))).not.toBeInTheDocument();
  });
});

describe("secrets", () => {
  it("stores and removes a declared secret without showing its value", async () => {
    const user = userEvent.setup();
    const items = [{ pluginId: "ai", point: "secrets", key: "api-key", decl: { name: "api-key", label: "API key" } }];
    render(<SecretsDetails plugin={plugin({ id: "ai" })} items={items} />);
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Value of API key"), "sk-1{Enter}");
    await waitFor(() => expect(screen.getByText("Stored")).toBeInTheDocument());
    expect(screen.getByLabelText("Value of API key")).toHaveValue("");
    expect(await backend.secrets("ai")).toEqual([{ name: "api-key", set: true }]);
    await user.click(screen.getByRole("button", { name: "Remove API key" }));
    await waitFor(() => expect(screen.getByText("Not set")).toBeInTheDocument());
    expect(await backend.secrets("ai")).toEqual([]);
  });
  it("shows a declared secret on the plugin's details page", async () => {
    const ai = plugin({ id: "ai", name: "AI Commit", contributions: [{ point: "secrets", label: "API key" }] });
    const snapshot = {
      plugins: [ai],
      activeTheme: null,
      ui: [{ pluginId: "ai", point: "secrets", key: "api-key", decl: { name: "api-key", label: "API key" } }],
    };
    setPluginsBackend({ ...createMemoryPluginsBackend([ai]), list: async () => snapshot });
    render(<PluginsPage initialTab="installed" />);
    expect(await screen.findByLabelText("Value of API key")).toBeInTheDocument();
  });
});

describe("plugin line markers", () => {
  it("groups related destinations on one line without hiding targets or run actions", () => {
    const doc = EditorState.create({ doc: "class Post extends Model {}" }).doc;
    const location = (path: string) => ({ path, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 4 } } });
    const marker = (path: string, icon: string | null = "navigate", pluginId = "laravel") => ({
      pluginId,
      line: 0,
      icon,
      tooltip: path,
      target: location(path),
    });
    const placed = placeMarkers(doc, [
      marker("/project/create_posts.php"),
      marker("/project/PostFactory.php"),
      marker("/project/PostFactory.php", null, "another-plugin"),
      marker("/project/PostPolicy.php"),
      marker("/project/run.php", "run"),
    ]);
    expect(placed).toHaveLength(2);
    expect(placed[0]!.markers.map((entry) => entry.target?.path)).toEqual([
      "/project/create_posts.php",
      "/project/PostFactory.php",
      "/project/PostPolicy.php",
    ]);
    expect(placed[1]!.icon).toBe("gutter-run");
  });
  it("places markers on existing lines and maps their icons", () => {
    const doc = EditorState.create({ doc: "a\nbb\nccc" }).doc;
    const marker = (line: number, icon: string | null) => ({ pluginId: "m", line, icon, tooltip: "t", target: null });
    expect(placeMarkers(doc, [marker(1, "run"), marker(7, null)]).map((m) => m.pos)).toEqual([2]);
    expect(markerIcon("database")).toBe("database");
    expect(markerIcon("run")).toBe("gutter-run");
    expect(markerIcon("implemented")).toBe("gutter-implemented");
    expect(markerIcon(null)).toBe("gutter-navigate");
    expect(markerIcon("unknown")).toBe("gutter-navigate");
  });
});

describe("marketplace", () => {
  it("lists the index's plugins and installs one through the install page", async () => {
    const asked: ConsentRequest[] = [];
    setConsentPrompt(async (req) => {
      asked.push(req);
      return { optional: [] };
    });
    const base = createMemoryPluginsBackend([], sampleCatalog());
    const downloads: string[] = [];
    setPluginsBackend({
      ...base,
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [
        {
          id: "hello",
          name: "Hello",
          version: "1.0.0",
          description: "From the marketplace",
          authors: [],
          publisher: "acme",
          download: "hello.oiplugin",
          digest: "x",
          capabilities: ["editor.write"],
          engine: "^1.0",
          installed: null,
          compatible: true,
        },
      ],
      // The memory backend installs its sample packages by path.
      marketDownload: async (id) => {
        downloads.push(id);
        return "plugins/hello";
      },
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("All Plugins")).toBeInTheDocument());
    expect(within(list).queryByText(new RegExp(NO_REPOSITORY))).not.toBeInTheDocument();
    await user.click(within(list).getAllByText("Hello")[0]!);
    expect(screen.getByText("Signed by acme")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(usePlugins.getState().plugins.map((p) => p.id)).toEqual(["hello"]));
    expect(downloads).toEqual(["hello"]);
    expect(asked[0]).toMatchObject({ pluginId: "hello", kind: "install" });
  });

  it("lists community plugins before the examples, selects the first and installs from a row", async () => {
    setConsentPrompt(async () => ({ optional: [] }));
    const entry = (id: string, name: string, more: object = {}) => ({
      id,
      name,
      version: "1.0.0",
      description: `${name} does things`,
      authors: [],
      publisher: id.split(".")[0]!,
      download: `${id}.oiplugin`,
      digest: "x",
      capabilities: [],
      engine: "^1.0",
      installed: null,
      compatible: true,
      ...more,
    });
    const downloads: string[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend([], sampleCatalog()),
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [
        entry("openidea.sample", "Sample"),
        entry("acme.rare", "Rare", { downloads: 2 }),
        entry("acme.popular", "Popular", { downloads: 1500, featured: true, publisherName: "Acme Inc." }),
      ],
      marketDownload: async (id) => {
        downloads.push(id);
        return "plugins/hello";
      },
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("Examples")).toBeInTheDocument());
    const headers = within(list)
      .getAllByText(/^(Featured|All Plugins|Examples|Local)$/)
      .map((h) => h.textContent);
    expect(headers).toEqual(["Featured", "All Plugins", "Examples", "Local"]);
    // The first listed plugin is shown without a click.
    expect(screen.getByRole("heading", { name: "Popular" })).toBeInTheDocument();
    expect(screen.getByText("Signed by Acme Inc.")).toBeInTheDocument();
    await user.click(within(list).getByText("Sample"));
    expect(screen.getByRole("note")).toHaveTextContent("not maintained as a product");
    await user.click(within(list).getByRole("button", { name: "Install Rare" }));
    await waitFor(() => expect(downloads).toEqual(["acme.rare"]));
  });

  it("doesn't claim there is no repository while one is configured", async () => {
    setPluginsBackend({
      ...createMemoryPluginsBackend([], []),
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [],
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    expect(await screen.findByText("No plugin selected")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(NO_REPOSITORY))).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter plugins" })).toHaveAttribute("placeholder", "Search plugins");
  });

  it("edits the repository from the gear menu; an empty URL restores the default", async () => {
    const base = createMemoryPluginsBackend([], []);
    const set: (string | null)[] = [];
    setPluginsBackend({
      ...base,
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [],
      setMarketUrl: async (url) => void set.push(url),
    });
    const user = userEvent.setup();
    render(
      <>
        <PluginsPage initialTab="installed" />
        <ContextMenuHost />
        <InputDialogsHost />
      </>,
    );
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    expect(screen.queryByRole("textbox", { name: /Marketplace index URL/ })).not.toBeInTheDocument();
    const edit = async (value: string) => {
      await user.click(screen.getByRole("button", { name: "Manage Plugins" }));
      await user.click(screen.getByRole("menuitem", { name: "Plugin Repository…" }));
      const field = await screen.findByRole("textbox", { name: /Marketplace index URL/ });
      await waitFor(() => expect(field).toHaveValue("https://plugins.example/index.json"));
      await user.clear(field);
      if (value) await user.type(field, value);
      await user.click(screen.getByRole("button", { name: "Save" }));
    };
    await edit("https://mirror.example/index.json");
    await edit("");
    await waitFor(() => expect(set).toEqual(["https://mirror.example/index.json", null]));
  });

  it("filters the marketplace by category", async () => {
    const entry = (id: string, name: string, categories: string[]) => ({
      id,
      name,
      version: "1.0.0",
      description: "",
      authors: [],
      publisher: "acme",
      download: `${id}.oiplugin`,
      digest: "x",
      capabilities: [],
      engine: "^1.0",
      categories,
      installed: null,
      compatible: true,
    });
    setPluginsBackend({
      ...createMemoryPluginsBackend([], sampleCatalog()),
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [
        entry("acme.dusk", "Dusk", ["themes"]),
        entry("acme.lint", "Lint", ["linters", "tools"]),
        entry("acme.misc", "Misc", ["robots"]),
      ],
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("Dusk")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Category" }));
    const options = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["All Categories3", "Themes1", "Linters & Formatters1", "Tools1", "Other1"]);
    await user.click(within(screen.getByRole("listbox")).getByText("Tools"));
    expect(within(list).queryByText("Dusk")).not.toBeInTheDocument();
    expect(within(list).queryByText("Local")).not.toBeInTheDocument();
    await user.click(within(list).getByText("Lint"));
    expect(screen.getByText("Linters & Formatters, Tools")).toBeInTheDocument();
  });

  it("shows a plugin this IDE can't load without installing it", async () => {
    setPluginsBackend({
      ...createMemoryPluginsBackend([], sampleCatalog()),
      marketUrl: async () => "https://plugins.example/index.json",
      market: async () => [
        {
          id: "acme.next",
          name: "Next",
          version: "2.0.0",
          description: "",
          authors: [],
          publisher: "acme",
          download: "next.oiplugin",
          digest: "x",
          capabilities: [],
          engine: "^9.0",
          installed: null,
          compatible: false,
        },
      ],
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("Incompatible")).toBeInTheDocument());
    await user.click(within(list).getByText("Next"));
    expect(screen.getByRole("note")).toHaveTextContent("Needs plugin API ^9.0. Update OpenIDEA to install it.");
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
  });

  describe("updates", () => {
    const offered = (id: string, version: string, installed: string): MarketPlugin => ({
      id,
      name: id.toUpperCase(),
      version,
      description: "",
      authors: [],
      publisher: "acme",
      download: `${id}.oiplugin`,
      digest: "x",
      capabilities: [],
      engine: "^1.0",
      installed,
      compatible: true,
    });
    const preview = (id: string, version: string, extra: Partial<InstallPreview> = {}): InstallPreview => ({
      id,
      name: id.toUpperCase(),
      version,
      description: "",
      authors: [],
      hasCode: true,
      capabilities: [
        { id: "editor.read", description: "Read", risk: "low", optional: false, granted: true },
        { id: "net:a.example", description: "Net", risk: "medium", optional: true, granted: true },
        { id: "net:b.example", description: "Net", risk: "medium", optional: true, granted: false },
      ],
      contributions: [],
      warnings: [],
      replaces: "1.0.0",
      unsigned: false,
      publisher: "acme",
      signerChanged: false,
      needsConsent: false,
      ...extra,
    });

    function updatesBackend(previews: Record<string, InstallPreview>) {
      const base = createMemoryPluginsBackend([
        plugin({ id: "a", version: "1.0.0" }),
        plugin({ id: "b", version: "1.0.0" }),
      ]);
      const consents: [string, Consent][] = [];
      setPluginsBackend({
        ...base,
        marketUrl: async () => "https://plugins.example/index.json",
        market: async () => [
          offered("a", "1.1.0", "1.0.0"),
          offered("b", "2.0.0", "1.0.0"),
          offered("c", "1.0.0", "1.0.0"),
        ],
        marketDownload: async (id) => id,
        previewInstall: async (dir) => previews[dir]!,
        installDir: async (dir, consent) => {
          consents.push([dir, consent]);
          return plugin({ id: dir, name: dir.toUpperCase(), version: previews[dir]!.version });
        },
      });
      return consents;
    }

    it("installs updates with nothing to confirm without asking, keeping their grants", async () => {
      const asked: ConsentRequest[] = [];
      setConsentPrompt(async (req) => {
        asked.push(req);
        return { optional: [], signerChange: !!req.signerChanged };
      });
      const consents = updatesBackend({
        a: preview("a", "1.1.0"),
        b: preview("b", "2.0.0", { signerChanged: true, needsConsent: true }),
      });
      expect(await updateAllPlugins()).toBe(2);
      // `a` with the optional capability it had; `b` asked, with the change of signer.
      expect(asked.map((r) => [r.pluginId, r.signerChanged])).toEqual([["b", true]]);
      expect(consents).toEqual([
        ["a", { optional: ["net:a.example"] }],
        ["b", { optional: [], signerChange: true }],
      ]);
      expect(notes.map((n) => n.title)).toEqual(["Updated 2 plugins"]);
    });

    it("warns about another signer on the install page and confirms it", async () => {
      const consents = updatesBackend({ b: preview("b", "2.0.0", { signerChanged: true, needsConsent: true }) });
      const stop = provideConsentDialog();
      const user = userEvent.setup();
      render(<ConsentDialogHost />);
      const done = installFromDisk("b");
      expect(await screen.findByRole("alert")).toHaveTextContent("signed with a different key");
      await user.click(screen.getByRole("button", { name: "Install" }));
      await done;
      expect(consents[0]![1]).toMatchObject({ signerChange: true });
      stop();
    });

    it("offers Update All in the gear menu while there are updates", async () => {
      setConsentPrompt(async () => ({ optional: [] }));
      const consents = updatesBackend({ a: preview("a", "1.1.0"), b: preview("b", "2.0.0") });
      const user = userEvent.setup();
      render(
        <>
          <PluginsPage initialTab="installed" />
          <ContextMenuHost />
        </>,
      );
      await waitFor(() => expect(usePlugins.getState().market).toHaveLength(3));
      await user.click(screen.getByRole("button", { name: "Manage Plugins" }));
      await user.click(screen.getByRole("menuitem", { name: "Update All Plugins (2)" }));
      await waitFor(() => expect(consents.map(([id]) => id)).toEqual(["a", "b"]));
    });

    it("links an installed plugin without its own homepage to its marketplace repository", async () => {
      const repository = "https://github.com/acme/a";
      setPluginsBackend({
        ...createMemoryPluginsBackend([plugin({ id: "a", name: "A Plugin", version: "1.0.0" })]),
        marketUrl: async () => "https://plugins.example/index.json",
        market: async () => [{ ...offered("a", "1.0.0", "1.0.0"), homepage: repository }],
      });
      render(<PluginsPage initialTab="installed" />);
      await screen.findByRole("heading", { level: 2, name: "A Plugin" });
      expect(await screen.findByRole("link", { name: repository })).toHaveAttribute("href", repository);
    });

    it("marks installed plugins with updates and updates one from its details", async () => {
      setConsentPrompt(async () => ({ optional: [] }));
      const consents = updatesBackend({ a: preview("a", "1.1.0"), b: preview("b", "2.0.0") });
      const user = userEvent.setup();
      render(<PluginsPage initialTab="installed" />);
      await waitFor(() => expect(usePlugins.getState().market).toHaveLength(3));
      const list = screen.getByRole("list", { name: "Installed plugins" });
      expect(within(list).getAllByText("Update")).toHaveLength(2);
      await user.click(within(list).getAllByRole("button", { name: /^b/i })[0]!);
      await user.click(await screen.findByRole("button", { name: "Update to 2.0.0" }));
      await waitFor(() => expect(consents.map(([id]) => id)).toEqual(["b"]));
    });

    it("announces updates with actions to install them or show the plugins", async () => {
      updatesBackend({ a: preview("a", "1.1.0"), b: preview("b", "2.0.0") });
      handlePluginEvent({
        type: "updatesAvailable",
        updates: [
          { id: "a", name: "A", version: "1.1.0" },
          { id: "b", name: "B", version: "2.0.0" },
        ],
      });
      const note = notes.at(-1)!;
      expect(note).toMatchObject({ title: "2 plugin updates available", body: "A 1.1.0, B 2.0.0" });
      expect(note.actions?.map((a) => a.label)).toEqual(["Update All", "Show Plugins"]);
      note.actions![0]!.run();
      await waitFor(() => expect(notes.at(-1)?.title).toBe("Updated 2 plugins"));
    });
  });

  it.each(["api.example.com", "::1", "ask"])(
    "revokes remembered host %s separately from capabilities",
    async (host) => {
      const user = userEvent.setup();
      const base = createMemoryPluginsBackend([
        plugin({
          id: "p",
          name: "P",
          netHosts: [host, "relay.example.org"],
          capabilities: [
            { id: "net:ask", risk: "medium", description: "Ask to connect", optional: true, granted: true },
          ],
        }),
      ]);
      const revokeNetHost = vi.fn((id: string, host: string) => base.revokeNetHost(id, host));
      setPluginsBackend({ ...base, revokeNetHost });
      render(<PluginsPage initialTab="installed" />);
      await screen.findByText("net:relay.example.org");
      expect(screen.getAllByText(`net:${host}`)).toHaveLength(host === "ask" ? 2 : 1);
      expect(screen.getByText("net:relay.example.org")).toBeInTheDocument();
      const rows = screen.getAllByRole("button", { name: "Remove" });
      await user.click(rows[0]!);
      await waitFor(() => expect(revokeNetHost).toHaveBeenCalledWith("p", host));
      await waitFor(() => expect(screen.queryAllByText(`net:${host}`)).toHaveLength(host === "ask" ? 1 : 0));
      expect(screen.getByText("net:relay.example.org")).toBeInTheDocument();
    },
  );

  it("offers to roll back an update", async () => {
    const base = createMemoryPluginsBackend([
      plugin({ id: "p", name: "P", version: "2.0.0", previousVersion: "1.0.0" }),
    ]);
    const rolled: string[] = [];
    setPluginsBackend({
      ...base,
      rollBack: async (id) => {
        rolled.push(id);
        return plugin({ id, name: "P", version: "1.0.0" });
      },
    });
    const user = userEvent.setup();
    render(<PluginsPage initialTab="installed" />);
    expect(await screen.findByText("Unsigned")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Roll Back to 1.0.0" }));
    await waitFor(() => expect(rolled).toEqual(["p"]));
    expect(notes.at(-1)).toMatchObject({ title: "Rolled back P to 1.0.0" });
  });

  describe("dependencies", () => {
    const needing = [{ id: "plus", name: "Plus", enabled: true }];

    it("shows what a plugin requires, who requires it, its extension points and why it is blocked", async () => {
      setPluginsBackend(
        createMemoryPluginsBackend([
          plugin({
            id: "plus",
            name: "Plus",
            status: "blocked",
            error: "Requires base ^1.0, but version 2.0.0 is installed",
            depends: [
              { id: "base", name: "Base", version: "^1.0", optional: false, state: "version" },
              { id: "extra", name: null, version: null, optional: true, state: "missing" },
            ],
            dependents: [{ id: "more", name: "More", enabled: false }],
            extensionPoints: [
              { id: "plus.things", description: "Things", contributors: ["more"] },
              { id: "plus.other", description: "", contributors: [] },
            ],
          }),
        ]),
      );
      render(<PluginsPage initialTab="installed" />);
      expect(await screen.findByText("Blocked")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Requires base ^1.0, but version 2.0.0 is installed");

      const requires = within(screen.getByRole("list", { name: "Required plugins" }));
      expect(requires.getByText("Base ^1.0")).toBeInTheDocument();
      expect(requires.getByText("Wrong version")).toBeInTheDocument();
      expect(requires.getByText("extra (optional)")).toBeInTheDocument();
      expect(requires.getByText("Not installed")).toBeInTheDocument();

      const requiredBy = within(screen.getByRole("list", { name: "Plugins that require this one" }));
      expect(requiredBy.getByText("More")).toBeInTheDocument();
      expect(requiredBy.getByText("Disabled")).toBeInTheDocument();

      const points = within(screen.getByRole("list", { name: "Extension points this plugin offers" }));
      expect(points.getByText("plus.things")).toBeInTheDocument();
      expect(points.getByText("Contributed by more")).toBeInTheDocument();
      expect(points.getByText("No contributions")).toBeInTheDocument();
    });

    it("asks before disabling a plugin that enabled plugins need", async () => {
      const calls: [string, boolean][] = [];
      setPluginsBackend({
        ...createMemoryPluginsBackend([plugin({ id: "base", name: "Base", dependents: needing })]),
        setEnabled: async (id, enabled) => void calls.push([id, enabled]),
      });
      const user = userEvent.setup();
      render(
        <>
          <PluginsPage initialTab="installed" />
          <MessagesHost />
        </>,
      );
      await user.click(await screen.findByRole("button", { name: "Disable" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Plus needs Base and stops while it is disabled");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(calls).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Disable" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disable" }));
      await waitFor(() => expect(calls).toEqual([["base", false]]));
    });

    it("names every enabled plugin that needs the one being disabled", async () => {
      setPluginsBackend(
        createMemoryPluginsBackend([
          plugin({
            id: "base",
            name: "Base",
            dependents: [
              { id: "plus", name: "Plus", enabled: true },
              { id: "extra", name: "Extra", enabled: true },
            ],
          }),
        ]),
      );
      const user = userEvent.setup();
      render(
        <>
          <PluginsPage initialTab="installed" />
          <MessagesHost />
        </>,
      );
      await user.click(await screen.findByRole("button", { name: "Disable" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "Plus, Extra need Base and stop while it is disabled",
      );
    });

    it("disables a plugin nothing enabled needs without asking", async () => {
      const calls: [string, boolean][] = [];
      setPluginsBackend({
        ...createMemoryPluginsBackend([
          plugin({ id: "base", name: "Base", dependents: [{ id: "plus", name: "Plus", enabled: false }] }),
        ]),
        setEnabled: async (id, enabled) => void calls.push([id, enabled]),
      });
      const user = userEvent.setup();
      render(
        <>
          <PluginsPage initialTab="installed" />
          <MessagesHost />
        </>,
      );
      await user.click(await screen.findByRole("button", { name: "Disable" }));
      await waitFor(() => expect(calls).toEqual([["base", false]]));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("icon themes", () => {
  const iconThemeUi = (pluginId: string, id: string) => ({
    pluginId,
    point: "iconThemes",
    key: id,
    decl: { id, label: id.toUpperCase(), icons: 1 },
  });

  it("adopts the first icon theme of a plugin when none is selected", async () => {
    useIconThemes.setState({ override: undefined });
    usePlugins.setState({ ui: [iconThemeUi("q", "other"), iconThemeUi("p", "first"), iconThemeUi("p", "second")] });
    await adoptIconTheme("p");
    expect(selectedIconTheme()).toBe("p/first");
    await adoptIconTheme("q");
    expect(selectedIconTheme()).toBe("p/first");
    useIconThemes.setState({ override: undefined });
  });

  it("names each icon theme's settings page after its plugin and theme", () => {
    syncUiContributions([iconThemeUi("acme.icons", "atom.dark")], [plugin({ id: "acme.icons", name: "Acme" })]);
    try {
      expect(useContributedIconThemes.getState().themes.find((t) => t.id === "acme.icons/atom.dark")).toMatchObject({
        label: "ATOM.DARK",
        settingsPage: "plugins.acme-icons.atom-dark",
      });
    } finally {
      clearUiContributions();
    }
  });

  it("adopts nothing for plugins without icon themes", async () => {
    useIconThemes.setState({ override: undefined });
    usePlugins.setState({ ui: [iconThemeUi("q", "other")] });
    await adoptIconTheme("p");
    expect(selectedIconTheme()).toBeNull();
  });

  it("resolves file names, then the longest extension, then the default icon", () => {
    const theme = iconResolver(
      {
        file: "file",
        fileNames: { "cargo.toml": "cargo" },
        fileExtensions: { "d.ts": "dts", ts: "ts", toml: "toml" },
      },
      (icon) => `ext:p/t/${icon}`,
      (name) => name !== "ext:p/t/toml",
    );
    expect(theme.file("Cargo.toml")).toBe("ext:p/t/cargo");
    expect(theme.file("a.d.ts")).toBe("ext:p/t/dts");
    expect(theme.file("a.ts")).toBe("ext:p/t/ts");
    expect(theme.file("x.toml")).toBe("ext:p/t/file");
    // No folder icons in this theme: folders keep the built-in ones.
    expect(theme.folder("src", false)).toBeNull();
  });

  it("resolves folders by name, then the default (expanded) folder icon", () => {
    const theme = iconResolver(
      {
        file: null,
        folder: "folder",
        folderExpanded: "folder-open",
        fileNames: {},
        fileExtensions: {},
        folderNames: { src: "folder-src" },
      },
      (icon) => `ext:p/t/${icon}`,
      () => true,
    );
    expect(theme.folder("SRC", true)).toBe("ext:p/t/folder-src");
    expect(theme.folder("lib", false)).toBe("ext:p/t/folder");
    expect(theme.folder("lib", true)).toBe("ext:p/t/folder-open");
    expect(theme.file("a.txt")).toBeNull();
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
    expect(filterCatalog(sampleCatalog(), "harbor").map((c) => c.id)).toEqual(["theme-harbor-night"]);
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

describe("plugin context keys", () => {
  it("applies plugin context keys from the backend", async () => {
    let keys = [
      { pluginId: "p", key: "isEntity", value: "true" },
      { pluginId: "p", key: "kind", value: '"pod"' },
    ];
    setPluginsBackend({
      ...createMemoryPluginsBackend(),
      contextKeys: async () => keys,
    });
    const changed = {
      type: "contextChanged",
      pluginId: "p",
      key: "isEntity",
      value: "true",
    } as const;
    expect(handleRuntimeEvent(changed)).toBe(true);
    await waitFor(() => expect(evaluateWhen("plugin.p.isEntity")).toBe(true));
    expect(evaluateWhen("plugin.p.kind == pod")).toBe(true);
    keys = keys.slice(1);
    handleRuntimeEvent({ ...changed, value: null });
    await waitFor(() => expect(evaluateWhen("plugin.p.isEntity")).toBe(false));
    expect(evaluateWhen("plugin.p.kind == pod")).toBe(true);
    keys = [];
    handleRuntimeEvent({ ...changed, key: "kind", value: null });
    await waitFor(() => expect(evaluateWhen("plugin.p.kind == pod")).toBe(false));
    expect("plugin.p.kind" in getContext()).toBe(false);
    expect("plugin.p.isEntity" in getContext()).toBe(false);
  });

  it("refreshes the keys when another backend publishes a project with the same root", async () => {
    let keys = [{ pluginId: "p", key: "backend", value: '"a"' }];
    setPluginsBackend({ ...createMemoryPluginsBackend(), contextKeys: async () => keys });
    const project = { root: "/p", trusted: true } as never;
    act(() => useProject.setState({ project }));
    const stop = startRuntimeUi();
    try {
      keys = [{ pluginId: "p", key: "backend", value: '"b"' }];
      act(() => useProject.setState({ project: { root: "/p", trusted: true } as never }));
      await waitFor(() => expect(evaluateWhen("plugin.p.backend == b")).toBe(true));
    } finally {
      stop();
      act(() => useProject.setState({ project: null }));
    }
  });

  it("coalesces a burst of changes into one follow-up fetch", async () => {
    type Keys = { pluginId: string; key: string; value: string }[];
    const pending: ((k: Keys) => void)[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend(),
      contextKeys: () => new Promise<Keys>((resolve) => pending.push(resolve)),
    });
    const event = { type: "contextChanged", pluginId: "p", key: "a", value: "true" } as const;
    for (let i = 0; i < 5; i++) handleRuntimeEvent(event);
    expect(pending).toHaveLength(1);
    pending[0]!([{ pluginId: "q", key: "b", value: "true" }]);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!([
      { pluginId: "p", key: "a", value: "true" },
      { pluginId: "q", key: "b", value: "true" },
    ]);
    await waitFor(() => expect(evaluateWhen("plugin.p.a")).toBe(true));
    expect(evaluateWhen("plugin.q.b")).toBe(true);
    await Promise.resolve();
    expect(pending).toHaveLength(2);

    handleRuntimeEvent({ ...event, value: null });
    expect(pending).toHaveLength(3);
    pending[2]!([{ pluginId: "q", key: "b", value: "true" }]);
    await waitFor(() => expect(evaluateWhen("plugin.p.a")).toBe(false));
    expect(evaluateWhen("plugin.q.b")).toBe(true);
  });

  it("fetches again after a failed fetch when changes arrived meanwhile", async () => {
    type Keys = { pluginId: string; key: string; value: string }[];
    const pending: { resolve: (k: Keys) => void; reject: () => void }[] = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend(),
      contextKeys: () =>
        new Promise<Keys>((resolve, reject) => pending.push({ resolve, reject: () => reject(new Error("x")) })),
    });
    const event = { type: "contextChanged", pluginId: "p", key: "f", value: "true" } as const;
    handleRuntimeEvent(event);
    handleRuntimeEvent(event);
    pending[0]!.reject();
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve([{ pluginId: "p", key: "f", value: "true" }]);
    await waitFor(() => expect(evaluateWhen("plugin.p.f")).toBe(true));
  });
});

it("asks the plugin for its routes once per plugin and again when they change", async () => {
  const plugins = [plugin({ id: "routes" })];
  const endpoints = vi.fn(async () => [
    {
      method: null,
      path: "/users/{id}",
      framework: "Rails",
      handler: "Users#show",
      location: { path: "/p/config/routes.rb", range: { start: { line: 2, col: 4 }, end: { line: 2, col: 8 } } },
    },
  ]);
  setPluginsBackend({ ...createMemoryPluginsBackend(), endpoints });
  const decl = (key: string) => ({ pluginId: "routes", point: "endpoints", key, decl: { files: [key] } });
  syncUiContributions([decl("config/routes.rb"), decl("routes/*.rb")], plugins);
  expect(await searchEndpoints("/p")).toMatchObject([
    { method: "*", url: "/users/{id}", handler: "Users#show", rel: "config/routes.rb", line: 2, col: 4 },
  ]);
  expect(endpoints).toHaveBeenCalledWith("routes");
  syncUiContributions([decl("config/routes.rb")], plugins);
  expect(await searchEndpoints("/p")).toHaveLength(1);

  const changed = vi.fn();
  const stop = onEndpointsChanged(changed);
  useProject.setState({ project: { root: "/p" } as never });
  handlePluginEvent({ type: "endpointsChanged", pluginId: "routes", root: "/other" });
  expect(changed).not.toHaveBeenCalled();
  handlePluginEvent({ type: "endpointsChanged", pluginId: "routes", root: "/p" });
  expect(changed).toHaveBeenCalledTimes(1);
  stop();

  syncUiContributions([], plugins);
  expect(await searchEndpoints("/p")).toEqual([]);
});
