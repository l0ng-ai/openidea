/**
 * Plugin host backend: `plugin_*` IPC + a `plugin_subscribe` event channel in the desktop
 * app; an in-memory simulation (the bundled samples) in plain-browser
 * development and tests.
 */
import { Channel } from "@tauri-apps/api/core";
import type { ActiveTheme, CatalogPlugin, PluginEvent, PluginInfo, PluginsSnapshot } from "@/bindings";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";

export interface PluginsBackend {
  list(): Promise<PluginsSnapshot>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  installDir(path: string): Promise<PluginInfo>;
  /** Plugin packages available locally (no network marketplace). */
  catalog(): Promise<CatalogPlugin[]>;
  uninstall(id: string): Promise<void>;
  reload(id: string): Promise<PluginInfo>;
  runCommand(pluginId: string, commandId: string, arg: string | null): Promise<string | null>;
  setActiveFile(path: string | null): Promise<void>;
  setTheme(pluginId: string | null, themeId: string | null): Promise<ActiveTheme | null>;
  /** The selected theme's resolved frame colour (`#rrggbb[aa]`), which new windows open in. */
  setThemeFrame(color: string | null): Promise<void>;
  /** Folder picker; `null` when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Subscribes to backend plugin events (this window only). */
  onEvent(handler: (e: PluginEvent) => void): () => void;
}

export const tauriPluginsBackend: PluginsBackend = {
  list: () => call(commands.pluginList()),
  setEnabled: async (id, enabled) => {
    await call(commands.pluginSetEnabled(id, enabled));
  },
  installDir: (path) => call(commands.pluginInstallDir(path)),
  catalog: () => call(commands.pluginCatalog()),
  uninstall: async (id) => {
    await call(commands.pluginUninstall(id));
  },
  reload: (id) => call(commands.pluginReload(id)),
  runCommand: (pluginId, commandId, arg) => call(commands.pluginRunCommand(pluginId, commandId, arg)),
  setActiveFile: async (path) => {
    await commands.pluginSetActiveFile(path);
  },
  setTheme: (pluginId, themeId) => call(commands.pluginSetTheme(pluginId, themeId)),
  setThemeFrame: async (color) => {
    await call(commands.pluginSetThemeFrame(color));
  },
  pickFolder: async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Install Plugin from Disk" });
    return (Array.isArray(picked) ? picked[0] : picked) ?? null;
  },
  onEvent: (handler) => {
    tauriListeners.add(handler);
    ensureSubscribed();
    return () => void tauriListeners.delete(handler);
  },
};

const tauriListeners = new Set<(e: PluginEvent) => void>();
let subscribed = false;

/** One channel per window; the backend addresses insert-text requests to the invoking window. */
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  const channel = new Channel<PluginEvent>();
  channel.onmessage = (e) => tauriListeners.forEach((l) => l(e));
  commands
    .pluginSubscribe(channel)
    // Anything that changed before the channel existed is picked up by a refresh.
    .then(() => tauriListeners.forEach((l) => l({ type: "commandsChanged" })))
    .catch(() => (subscribed = false));
}

// ---------------------------------------------------------------------------
// Browser simulation: the bundled sample plugins, with `hello` implemented in JS.

// templates/theme-plugin, abridged.
const SAMPLE_THEMES: ActiveTheme["theme"][] = [
  {
    id: "harbor-night",
    name: "Harbor Night",
    kind: "dark",
    tokens: {
      "--bg-app": "#14171c",
      "--bg-island": "#14171c",
      "--bg-frame": "#1f252e",
      "--bg-elev": "#1b2027",
      "--fg": "#c9d1dc",
      "--accent": "#2b9e93",
      "--syn-keyword": "#e0a46e",
      "--syn-string": "#9ccc7a",
    },
  },
];

function samplePlugins(): PluginInfo[] {
  const base = {
    authors: ["OpenIDEA contributors"],
    homepage: null,
    changeNotes: null,
    source: "installed" as const,
    enabled: true,
    error: null,
    languages: [],
    themes: [],
    codeNavigation: [],
    commands: [],
    permissions: [],
  };
  return [
    {
      ...base,
      id: "hello",
      name: "Hello",
      version: "0.1.0",
      description: "Sample plugin: inserts today's date and counts words in the active file.",
      path: "~/Library/Application Support/ai.l0ng.openidea/plugins/hello",
      status: "active",
      hasCode: true,
      permissions: ["project-read", "editor-read", "editor-write"],
      commands: [
        { id: "insert-date", title: "Hello: Insert Date", category: "Hello" },
        { id: "word-count", title: "Hello: Word Count of Active File", category: "Hello" },
      ],
    },
    {
      ...base,
      id: "theme-harbor-night",
      name: "Harbor Night Theme",
      version: "1.0.0",
      description: "Example dark theme: slate surfaces, a teal accent and a warm syntax palette.",
      path: "~/Library/Application Support/ai.l0ng.openidea/plugins/theme-harbor-night",
      status: "static",
      hasCode: false,
      themes: SAMPLE_THEMES.map(({ id, name, kind }) => ({ id, name, kind })),
      codeNavigation: [],
    },
    {
      ...base,
      id: "language-toy",
      name: "Toy Language",
      version: "0.1.0",
      description: "Language support for .toy files: detection, comments and indentation.",
      path: "~/Library/Application Support/ai.l0ng.openidea/plugins/language-toy",
      status: "static",
      hasCode: false,
      languages: [{ id: "toy", name: "Toy", extensions: ["toy"] }],
    },
  ];
}

/** The sample packages as a local catalog (the desktop app scans `plugins/`). */
export function sampleCatalog(): CatalogPlugin[] {
  return samplePlugins().map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    description: p.description,
    authors: p.authors,
    homepage: p.homepage,
    changeNotes: `${p.version} — first release.`,
    path: `plugins/${p.id}`,
    hasCode: p.hasCode,
    permissions: p.permissions,
    commands: p.commands,
    languageCount: p.languages.length,
    themeCount: p.themes.length,
    problem: null,
  }));
}

export function createMemoryPluginsBackend(
  initial: PluginInfo[] = samplePlugins(),
  catalog: CatalogPlugin[] = sampleCatalog(),
): PluginsBackend {
  let plugins = initial.map((p) => ({ ...p }));
  const templates = samplePlugins();
  let theme: { pluginId: string; themeId: string } | null = null;
  let activeFile: string | null = null;
  const listeners = new Set<(e: PluginEvent) => void>();
  const emit = (e: PluginEvent) => listeners.forEach((l) => l(e));
  const find = (id: string) => {
    const p = plugins.find((x) => x.id === id);
    if (!p) throw new IpcError({ kind: "notFound", message: `no plugin "${id}"` });
    return p;
  };
  const activeTheme = (): ActiveTheme | null => {
    if (!theme) return null;
    const p = plugins.find((x) => x.id === theme?.pluginId);
    const t = SAMPLE_THEMES.find((x) => x.id === theme?.themeId);
    if (!p?.enabled || !t) return null;
    return { pluginId: p.id, theme: t };
  };
  return {
    list: async () => ({ plugins: plugins.map((p) => ({ ...p })), activeTheme: activeTheme() }),
    setEnabled: async (id, enabled) => {
      const p = find(id);
      p.enabled = enabled;
      p.status = enabled ? (p.hasCode ? "active" : "static") : "disabled";
      p.error = null;
      emit({ type: "commandsChanged" });
      if (theme?.pluginId === id) emit({ type: "themeChanged", theme: activeTheme() });
    },
    installDir: async (path) => {
      // Only catalog packages can be "installed" here; there are no files in the browser.
      const entry = catalog.find((c) => c.path === path);
      const template = entry && templates.find((t) => t.id === entry.id);
      if (!entry || !template) {
        throw new IpcError({ kind: "unavailable", message: `installing ${path} requires the desktop app` });
      }
      const info: PluginInfo = { ...template, version: entry.version, changeNotes: entry.changeNotes };
      plugins = [...plugins.filter((p) => p.id !== entry.id), info];
      emit({ type: "commandsChanged" });
      return { ...info };
    },
    catalog: async () => catalog.map((c) => ({ ...c })),
    uninstall: async (id) => {
      find(id);
      plugins = plugins.filter((p) => p.id !== id);
      emit({ type: "commandsChanged" });
    },
    reload: async (id) => find(id),
    runCommand: async (pluginId, commandId) => {
      const p = find(pluginId);
      if (p.status !== "active")
        throw new IpcError({ kind: "unavailable", message: `plugin "${pluginId}" is not running` });
      if (commandId === "insert-date") {
        const date = new Date().toISOString().slice(0, 10);
        emit({ type: "insertText", pluginId, text: date });
        return date;
      }
      if (commandId === "word-count") {
        if (!activeFile) throw new IpcError({ kind: "internal", message: "no file is open in the editor" });
        const name = activeFile.split("/").pop() ?? activeFile;
        emit({ type: "notification", pluginId, level: "info", title: `Word count: ${name}`, body: "(simulated)" });
        return null;
      }
      throw new IpcError({ kind: "internal", message: `unknown command: ${commandId}` });
    },
    setActiveFile: async (path) => {
      activeFile = path;
    },
    setTheme: async (pluginId, themeId) => {
      theme = pluginId && themeId ? { pluginId, themeId } : null;
      const t = activeTheme();
      emit({ type: "themeChanged", theme: t });
      return t;
    },
    setThemeFrame: async () => {},
    pickFolder: async () => null,
    onEvent: (handler) => {
      listeners.add(handler);
      return () => void listeners.delete(handler);
    },
  };
}

let current: PluginsBackend | null = null;

export function pluginsBackend(): PluginsBackend {
  return (current ??= isTauri() ? tauriPluginsBackend : createMemoryPluginsBackend());
}

/** Test hook. */
export function setPluginsBackend(b: PluginsBackend | null) {
  current = b;
}
