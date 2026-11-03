import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { PluginInfo } from "@/bindings";
import { _setActiveEditor } from "@/editor/api";
import { executeAction, executeActionFrom, getAction, registerAction } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { applyThemeAttributes, useThemeOverride } from "@/workbench/theme";
import { createMemoryPluginsBackend, sampleCatalog, setPluginsBackend, type PluginsBackend } from "../backend";
import {
  applyPluginTheme,
  PLUGIN_THEME_STYLE_ID,
  handlePluginEvent,
  pluginActionId,
  startPluginBridge,
} from "../bridge";
import { iconResolver } from "../iconThemes";
import { markerIcon, placeMarkers } from "../lineMarkerGutter";
import { SecretsDetails } from "../secrets";
import { usePluginStatusItems } from "../runtimeUi";
import { useTasks } from "@/workbench/tasks";
import { defineBuiltinUiPoints } from "../points";
import { clearUiContributions, defineUiPoint, syncUiContributions } from "../projection";
import { catalogState, filterCatalog, filterPlugins, NO_REPOSITORY, PluginsPage } from "../PluginsPage";
import {
  compareVersions,
  installFromDisk,
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
    source: "installed",
    path: `/plugins/${partial.id}`,
    enabled: true,
    status: "active",
    error: null,
    hasCode: true,
    capabilities: [],
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
    expect(getAction("plugin.a.go")).toMatchObject({ title: "T go", category: "Alpha" });
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
      ],
    ]);
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

  it("restarts a failed plugin instead of disabling it", async () => {
    setPluginsBackend(createMemoryPluginsBackend([plugin({ id: "broken", status: "failed", error: "trap" })]));
    const user = userEvent.setup();
    render(<PluginsPage />);
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    await waitFor(() => expect(usePlugins.getState().plugins[0]).toMatchObject({ enabled: true, status: "inactive" }));
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
});

describe("plugin line markers", () => {
  it("places markers on existing lines and maps their icons", () => {
    const doc = EditorState.create({ doc: "a\nbb\nccc" }).doc;
    const marker = (line: number, icon: string | null) => ({ pluginId: "m", line, icon, tooltip: "t", target: null });
    expect(placeMarkers(doc, [marker(1, "run"), marker(7, null)]).map((m) => m.pos)).toEqual([2]);
    expect(markerIcon("run")).toBe("gutter-run");
    expect(markerIcon("implemented")).toBe("gutter-implemented");
    expect(markerIcon(null)).toBe("gutter-implementing");
    expect(markerIcon("unknown")).toBe("gutter-implementing");
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
          installed: null,
        },
      ],
      // The memory backend installs its sample packages by path.
      marketDownload: async (id) => {
        downloads.push(id);
        return "plugins/hello";
      },
    });
    const user = userEvent.setup();
    render(<PluginsPage />);
    await user.click(screen.getByRole("tab", { name: /Available/ }));
    const list = await screen.findByRole("list", { name: "Available plugins" });
    await waitFor(() => expect(within(list).getByText("Marketplace")).toBeInTheDocument());
    expect(within(list).queryByText(new RegExp(NO_REPOSITORY))).not.toBeInTheDocument();
    await user.click(within(list).getAllByText("Hello")[0]!);
    expect(screen.getByText("Signed by acme")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(usePlugins.getState().plugins.map((p) => p.id)).toEqual(["hello"]));
    expect(downloads).toEqual(["hello"]);
    expect(asked[0]).toMatchObject({ pluginId: "hello", kind: "install" });
  });

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
    render(<PluginsPage />);
    expect(await screen.findByText("Unsigned")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Roll Back to 1.0.0" }));
    await waitFor(() => expect(rolled).toEqual(["p"]));
    expect(notes.at(-1)).toMatchObject({ title: "Rolled back P to 1.0.0" });
  });
});

describe("icon themes", () => {
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
