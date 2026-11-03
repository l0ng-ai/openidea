/**
 * Plugin host backend: `plugin_*` IPC + a `plugin_subscribe` event channel in the desktop
 * app; an in-memory simulation (the bundled samples) in plain-browser
 * development and tests.
 */
import { Channel } from "@tauri-apps/api/core";
import type {
  ActiveTheme,
  CapabilityInfo,
  CatalogPlugin,
  Consent,
  EventKind,
  InstallPreview,
  MarketPlugin,
  PluginEditor,
  PluginEvent,
  PluginInfo,
  PluginsSnapshot,
  PluginSecretState,
  PluginStatusItem,
  UiContribution,
  View,
  ViewEvent,
  Viewport,
  WorkbenchEvent,
} from "@/bindings";
import { call, commands, IpcError, isTauri } from "@/platform/ipc";

export interface PluginsBackend {
  list(): Promise<PluginsSnapshot>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Validates a package for the install page; nothing is copied. */
  previewInstall(path: string): Promise<InstallPreview>;
  installDir(path: string, consent: Consent): Promise<PluginInfo>;
  /** Confirms a plugin waiting for consent. */
  grant(id: string, consent: Consent): Promise<PluginInfo>;
  setCapability(id: string, capability: string, granted: boolean): Promise<PluginInfo>;
  /** Validated assets (icon theme mapping and SVGs) whose id starts with `prefix`. */
  assets(pluginId: string, prefix: string): Promise<[string, string][]>;
  /** `language` / `file` / `view` activation events. */
  activationEvent(kind: "language" | "file" | "view", value: string): Promise<void>;
  /** Plugin packages available locally (no network marketplace). */
  catalog(): Promise<CatalogPlugin[]>;
  uninstall(id: string): Promise<void>;
  reload(id: string): Promise<PluginInfo>;
  /** Runs a command with the focused editor (path, language, selections) as its context. */
  runCommand(
    pluginId: string,
    commandId: string,
    arg: string | null,
    editor: PluginEditor | null,
  ): Promise<string | null>;
  /** Workbench events plugins subscribed to (see `eventKinds`). */
  postEvents(events: WorkbenchEvent[]): Promise<void>;
  /** Kinds of workbench events plugins want; re-fetch on `subscriptionsChanged`. */
  eventKinds(): Promise<EventKind[]>;
  /** Plugin status bar items (later changes arrive as `statusItemChanged`). */
  statusItems(): Promise<PluginStatusItem[]>;
  cancelTask(taskId: string): Promise<void>;
  /** Marketplace plugins: the index read again (`refresh`) or the last one read. */
  market(refresh: boolean): Promise<MarketPlugin[]>;
  marketUrl(): Promise<string | null>;
  setMarketUrl(url: string | null): Promise<void>;
  /** Downloads and checks a marketplace plugin; the folder to install from. */
  marketDownload(id: string): Promise<string>;
  /** Unpacks a `.oiplugin` package file; the folder to install from. */
  unpackPackage(path: string): Promise<string>;
  /** Goes back to the version the last update replaced. */
  rollBack(id: string): Promise<PluginInfo>;
  /** File picker for a package file; `null` when cancelled. */
  pickPackage(): Promise<string | null>;
  /** Content of a plugin view (`doc`: the document of a custom editor). */
  renderView(pluginId: string, view: string, viewport: Viewport | null, doc: number | null): Promise<View>;
  viewEvent(pluginId: string, view: string, event: ViewEvent, doc: number | null): Promise<void>;
  /** Which of a plugin's declared secrets are stored (values never come back). */
  secrets(pluginId: string): Promise<PluginSecretState[]>;
  /** Stores a secret (`null` removes it). */
  setSecret(pluginId: string, name: string, value: string | null): Promise<void>;
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
  previewInstall: (path) => call(commands.pluginPreviewInstall(path)),
  installDir: (path, consent) => call(commands.pluginInstallDir(path, consent)),
  grant: (id, consent) => call(commands.pluginGrant(id, consent)),
  setCapability: (id, capability, granted) => call(commands.pluginSetCapability(id, capability, granted)),
  assets: (pluginId, prefix) => call(commands.pluginAssets(pluginId, prefix)),
  activationEvent: async (kind, value) => {
    await call(commands.pluginActivationEvent(kind, value));
  },
  catalog: () => call(commands.pluginCatalog()),
  uninstall: async (id) => {
    await call(commands.pluginUninstall(id));
  },
  reload: (id) => call(commands.pluginReload(id)),
  runCommand: (pluginId, commandId, arg, editor) => call(commands.pluginRunCommand(pluginId, commandId, arg, editor)),
  postEvents: async (events) => {
    await commands.pluginPostEvents(events);
  },
  eventKinds: () => commands.pluginEventKinds(),
  statusItems: () => commands.pluginStatusItems(),
  cancelTask: async (taskId) => {
    await commands.pluginCancelTask(taskId);
  },
  market: (refresh) => call(commands.pluginMarket(refresh)),
  marketUrl: () => commands.pluginMarketUrl(),
  setMarketUrl: async (url) => {
    await commands.pluginSetMarketUrl(url);
  },
  marketDownload: (id) => call(commands.pluginMarketDownload(id)),
  unpackPackage: (path) => call(commands.pluginUnpackPackage(path)),
  rollBack: (id) => call(commands.pluginRollBack(id)),
  pickPackage: async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      title: "Install Plugin from Package File",
      filters: [{ name: "OpenIDEA plugin", extensions: ["oiplugin"] }],
    });
    return (Array.isArray(picked) ? picked[0] : picked) ?? null;
  },
  renderView: (pluginId, view, viewport, doc) => call(commands.pluginViewRender(pluginId, view, viewport, doc)),
  viewEvent: async (pluginId, view, event, doc) => {
    await call(commands.pluginViewEvent(pluginId, view, event, doc));
  },
  secrets: (pluginId) => call(commands.pluginSecrets(pluginId)),
  setSecret: async (pluginId, name, value) => {
    await call(commands.pluginSetSecret(pluginId, name, value));
  },
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

/** One channel per window; the backend addresses notifications and consent requests to the invoking window. */
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

const cap = (id: string, risk: CapabilityInfo["risk"], description: string): CapabilityInfo => ({
  id,
  risk,
  description,
  optional: false,
  granted: true,
});

const HELLO_COMMANDS = [
  { id: "insert-date", title: "Hello: Insert Date", category: "Hello" },
  { id: "word-count", title: "Hello: Word Count of Active File", category: "Hello" },
];

/** UI contributions of the sample plugins (what the backend would project). */
function sampleUi(id: string): UiContribution[] {
  if (id === "hello") return HELLO_COMMANDS.map((c) => ({ pluginId: id, point: "commands", key: c.id, decl: c }));
  if (id === "theme-harbor-night")
    return SAMPLE_THEMES.map((t) => ({ pluginId: id, point: "themes", key: t.id, decl: t }));
  return [];
}

function samplePlugins(): PluginInfo[] {
  const base = {
    authors: ["OpenIDEA contributors"],
    homepage: null,
    changeNotes: null,
    source: "installed" as const,
    enabled: true,
    error: null,
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
  };
  return [
    {
      ...base,
      id: "hello",
      name: "Hello",
      version: "0.1.0",
      description: "Sample plugin: inserts today's date and counts words in the active file.",
      path: "~/Library/Application Support/ai.l0ng.openidea/plugins/hello",
      status: "inactive",
      hasCode: true,
      activation: ["on-startup-finished"],
      capabilities: [
        cap("editor.write", "medium", "Change text in the editor"),
        cap("project.read", "low", "Read files in the open project"),
        cap("editor.read", "low", "Read the focused editor's file and selection"),
      ],
      contributions: HELLO_COMMANDS.map((c) => ({ point: "commands", label: c.title })),
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
      contributions: SAMPLE_THEMES.map((t) => ({ point: "themes", label: t.name })),
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
      contributions: [{ point: "languages", label: "Toy (.toy)" }],
    },
  ];
}

/** The sample packages as a local catalog (the desktop app scans `plugins/`). */
export function sampleCatalog(): CatalogPlugin[] {
  return samplePlugins().map((p) => {
    const counts = new Map<string, number>();
    for (const c of p.contributions) counts.set(c.point, (counts.get(c.point) ?? 0) + 1);
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      authors: p.authors,
      homepage: p.homepage,
      changeNotes: `${p.version} — first release.`,
      path: `plugins/${p.id}`,
      hasCode: p.hasCode,
      capabilities: p.capabilities.map((c) => ({ ...c, granted: false })),
      contributions: [...counts].map(([point, count]) => ({ point, count })),
      problem: null,
    };
  });
}

const live = (p: PluginInfo) => p.status === "active" || p.status === "inactive" || p.status === "static";

export function createMemoryPluginsBackend(
  initial: PluginInfo[] = samplePlugins(),
  catalog: CatalogPlugin[] = sampleCatalog(),
): PluginsBackend {
  let plugins = initial.map((p) => ({ ...p }));
  const templates = samplePlugins();
  let theme: { pluginId: string; themeId: string } | null = null;
  let activeFile: string | null = null;
  const secrets = new Map<string, string>();
  let marketUrl: string | null = null;
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
  const ui = () => plugins.filter(live).flatMap((p) => sampleUi(p.id));
  const preview = (path: string): InstallPreview => {
    const entry = catalog.find((c) => c.path === path);
    if (!entry) throw new IpcError({ kind: "unavailable", message: `installing ${path} requires the desktop app` });
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      authors: entry.authors,
      hasCode: entry.hasCode,
      capabilities: entry.capabilities,
      contributions: entry.contributions,
      warnings: [],
      replaces: plugins.find((p) => p.id === entry.id)?.version ?? null,
      unsigned: true,
      publisher: null,
    };
  };
  return {
    list: async () => ({ plugins: plugins.map((p) => ({ ...p })), activeTheme: activeTheme(), ui: ui() }),
    setEnabled: async (id, enabled) => {
      const p = find(id);
      p.enabled = enabled;
      p.status = enabled ? (p.hasCode ? "inactive" : "static") : "disabled";
      p.error = null;
      emit({ type: "commandsChanged" });
      if (theme?.pluginId === id) emit({ type: "themeChanged", theme: activeTheme() });
    },
    previewInstall: async (path) => preview(path),
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
    grant: async (id) => {
      const p = find(id);
      p.status = p.hasCode ? "inactive" : "static";
      p.capabilities = p.capabilities.map((c) => ({ ...c, granted: true }));
      emit({ type: "commandsChanged" });
      return { ...p };
    },
    setCapability: async (id, capability, granted) => {
      const p = find(id);
      p.capabilities = p.capabilities.map((c) => (c.id === capability ? { ...c, granted } : c));
      if (!granted && p.capabilities.some((c) => c.id === capability && !c.optional)) p.status = "needsConsent";
      emit({ type: "commandsChanged" });
      return { ...p };
    },
    assets: async () => [],
    activationEvent: async () => {},
    catalog: async () => catalog.map((c) => ({ ...c })),
    uninstall: async (id) => {
      find(id);
      plugins = plugins.filter((p) => p.id !== id);
      emit({ type: "commandsChanged" });
    },
    reload: async (id) => find(id),
    runCommand: async (pluginId, commandId) => {
      const p = find(pluginId);
      if (p.status !== "active" && p.status !== "inactive")
        throw new IpcError({ kind: "unavailable", message: `plugin "${pluginId}" is not running` });
      p.status = "active";
      if (commandId === "insert-date") return new Date().toISOString().slice(0, 10);
      if (commandId === "word-count") {
        if (!activeFile) throw new IpcError({ kind: "internal", message: "no file is open in the editor" });
        const name = activeFile.split("/").pop() ?? activeFile;
        emit({ type: "notification", pluginId, level: "info", title: `Word count: ${name}`, body: "(simulated)" });
        return null;
      }
      throw new IpcError({ kind: "internal", message: `unknown command: ${commandId}` });
    },
    postEvents: async () => {},
    eventKinds: async () => [],
    statusItems: async () => [],
    cancelTask: async () => {},
    market: async () => [],
    marketUrl: async () => marketUrl,
    setMarketUrl: async (url) => {
      marketUrl = url;
    },
    marketDownload: async (id) => {
      throw new IpcError({ kind: "unavailable", message: `installing ${id} requires the desktop app` });
    },
    unpackPackage: async (path) => {
      throw new IpcError({ kind: "unavailable", message: `unpacking ${path} requires the desktop app` });
    },
    rollBack: async (id) => {
      throw new IpcError({ kind: "notFound", message: `${id} has no earlier version to roll back to` });
    },
    pickPackage: async () => null,
    renderView: async (pluginId, view) => ({
      toolbar: [],
      body: { kind: "message", value: `${pluginId} · ${view} (plugin views need the desktop app)` },
      status: null,
    }),
    viewEvent: async () => {},
    secrets: async (pluginId) =>
      [...secrets.entries()]
        .filter(([k]) => k.startsWith(`${pluginId}/`))
        .map(([k]) => ({ name: k.slice(pluginId.length + 1), set: true })),
    setSecret: async (pluginId, name, value) => {
      if (value === null) secrets.delete(`${pluginId}/${name}`);
      else secrets.set(`${pluginId}/${name}`, value);
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
