/** Installed plugins, their UI contributions, the selected plugin theme, and the operations on them. */
import { create } from "zustand";
import type {
  ActiveTheme,
  CapabilityInfo,
  CatalogPlugin,
  Consent,
  MarketPlugin,
  PluginInfo,
  PluginStatus,
  UiContribution,
} from "@/bindings";
import { notifications } from "@/workbench/contributions";
import { pluginsBackend, type PluginsBackend } from "./backend";
import { editorContext } from "./editorContext";
import { iconThemeKey, selectedIconTheme, selectIconTheme } from "./iconThemes";

export const SETTINGS_PAGE_ID = "plugins";

interface PluginsState {
  plugins: PluginInfo[];
  /** UI contributions of live plugins, projected by `projection.ts`. */
  ui: UiContribution[];
  activeTheme: ActiveTheme | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Plugin ids with an operation in flight. */
  busy: Readonly<Record<string, boolean>>;
  installing: boolean;
  /** Locally available packages (Marketplace tab); `null` until loaded. */
  catalog: CatalogPlugin[] | null;
  catalogError: string | null;
  /** The marketplace index URL; `null` when none is configured. */
  marketUrl: string | null;
  /** Plugins of the marketplace index; `null` until read. */
  market: MarketPlugin[] | null;
  marketError: string | null;
}

export const usePlugins = create<PluginsState>(() => ({
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
  marketUrl: null,
  market: null,
  marketError: null,
}));

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Statuses whose contributions are in effect. */
export const isLive = (status: PluginStatus) => status === "active" || status === "inactive" || status === "static";

// --- consent ------------------------------------------------------------------

/** What a consent prompt shows: an install preview or a plugin waiting for permission. */
export interface ConsentRequest {
  pluginId: string;
  name: string;
  version: string;
  /** Install page (new or update) or a permission prompt for an installed/project plugin. */
  kind: "install" | "grant";
  capabilities: CapabilityInfo[];
  /** Unsigned package (from disk or a project folder). */
  unsigned: boolean;
  warnings: string[];
}

type ConsentPrompt = (req: ConsentRequest) => Promise<Consent | null>;

let consentPrompt: ConsentPrompt | null = null;

/** The dialog that asks (registered by `consent.tsx`; tests substitute their own). */
export function setConsentPrompt(prompt: ConsentPrompt | null) {
  consentPrompt = prompt;
}

/** Without a prompt only plugins asking for nothing are accepted. */
function askConsent(req: ConsentRequest): Promise<Consent | null> {
  if (consentPrompt) return consentPrompt(req);
  return Promise.resolve(req.capabilities.length === 0 ? { optional: [] } : null);
}

// --- loading ------------------------------------------------------------------

let generation = 0;

export async function refreshPlugins(): Promise<void> {
  const gen = ++generation;
  usePlugins.setState({ loading: true });
  try {
    const snapshot = await pluginsBackend().list();
    if (gen !== generation) return;
    usePlugins.setState({
      plugins: snapshot.plugins,
      ui: snapshot.ui,
      activeTheme: snapshot.activeTheme,
      loaded: true,
      loading: false,
      error: null,
    });
  } catch (e) {
    if (gen !== generation) return;
    usePlugins.setState({ loading: false, loaded: true, error: errorText(e) });
  }
}

async function withBusy(id: string, title: string, op: () => Promise<unknown>): Promise<boolean> {
  usePlugins.setState((s) => ({ busy: { ...s.busy, [id]: true } }));
  try {
    await op();
    return true;
  } catch (e) {
    notifications().notify({ group: "plugins", level: "error", title, body: errorText(e) });
    return false;
  } finally {
    usePlugins.setState((s) => {
      const busy = { ...s.busy };
      delete busy[id];
      return { busy };
    });
    await refreshPlugins();
  }
}

const nameOf = (id: string) => usePlugins.getState().plugins.find((p) => p.id === id)?.name ?? id;

export async function adoptIconTheme(pluginId: string): Promise<void> {
  if (selectedIconTheme()) return;
  const first = usePlugins.getState().ui.find((c) => c.pluginId === pluginId && c.point === "iconThemes");
  const id = (first?.decl as { id?: unknown } | undefined)?.id;
  if (typeof id === "string") await selectIconTheme(iconThemeKey(pluginId, id));
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<boolean> {
  const done = await withBusy(id, `Could not ${enabled ? "enable" : "disable"} ${nameOf(id)}`, () =>
    pluginsBackend().setEnabled(id, enabled),
  );
  if (done && enabled) await adoptIconTheme(id);
  return done;
}

export function reloadPlugin(id: string): Promise<boolean> {
  return withBusy(id, `Could not reload ${nameOf(id)}`, () => pluginsBackend().reload(id));
}

export function uninstallPlugin(id: string): Promise<boolean> {
  const name = nameOf(id);
  return withBusy(id, `Could not uninstall ${name}`, async () => {
    await pluginsBackend().uninstall(id);
    notifications().notify({ group: "plugins", level: "info", title: `Uninstalled ${name}` });
  });
}

/** Asks for (and records) the permissions of a plugin waiting for consent. */
export async function grantPlugin(id: string, capabilities?: CapabilityInfo[]): Promise<boolean> {
  const plugin = usePlugins.getState().plugins.find((p) => p.id === id);
  if (!plugin) return false;
  const consent = await askConsent({
    pluginId: id,
    name: plugin.name,
    version: plugin.version,
    kind: "grant",
    capabilities: capabilities ?? plugin.capabilities,
    unsigned: plugin.source !== "installed",
    warnings: plugin.warnings,
  });
  if (!consent) return false;
  return withBusy(id, `Could not enable ${plugin.name}`, () => pluginsBackend().grant(id, consent));
}

export function setPluginCapability(id: string, capability: string, granted: boolean): Promise<boolean> {
  return withBusy(id, `Could not change ${capability} of ${nameOf(id)}`, () =>
    pluginsBackend().setCapability(id, capability, granted),
  );
}

export async function refreshCatalog(): Promise<void> {
  try {
    usePlugins.setState({ catalog: await pluginsBackend().catalog(), catalogError: null });
  } catch (e) {
    usePlugins.setState({ catalog: [], catalogError: errorText(e) });
  }
}

/** The marketplace's plugins: the index read again with `refresh`. */
export async function refreshMarket(refresh = true): Promise<void> {
  const backend = pluginsBackend();
  try {
    const marketUrl = await backend.marketUrl();
    usePlugins.setState({ marketUrl });
    if (!marketUrl) return usePlugins.setState({ market: null, marketError: null });
    usePlugins.setState({ market: await backend.market(refresh), marketError: null });
  } catch (e) {
    usePlugins.setState({ marketError: errorText(e) });
  }
}

export async function setMarketUrl(url: string | null): Promise<void> {
  await pluginsBackend().setMarketUrl(url?.trim() || null);
  await refreshMarket(true);
}

/** Downloads (and checks) a marketplace plugin, then the install page as from disk. */
export async function installFromMarket(id: string): Promise<string | null> {
  usePlugins.setState({ installing: true });
  let dir: string;
  try {
    dir = await pluginsBackend().marketDownload(id);
  } catch (e) {
    usePlugins.setState({ installing: false });
    notifications().notify({
      group: "plugins",
      level: "error",
      title: "Could not download plugin",
      body: errorText(e),
    });
    return null;
  }
  const installed = await installFromDisk(dir);
  void refreshMarket(false);
  return installed;
}

/** Settings › Plugins › Roll Back: the version before the last update. */
export async function rollBackPlugin(id: string): Promise<void> {
  try {
    const info = await pluginsBackend().rollBack(id);
    notifications().notify({ group: "plugins", level: "info", title: `Rolled back ${info.name} to ${info.version}` });
  } catch (e) {
    notifications().notify({ group: "plugins", level: "error", title: "Could not roll back", body: errorText(e) });
  } finally {
    await refreshPlugins();
  }
}

/** Enables or disables every installed (non-dev) plugin; returns how many changed. */
export async function setAllInstalledEnabled(enabled: boolean): Promise<number> {
  const targets = usePlugins.getState().plugins.filter((p) => p.source === "installed" && p.enabled !== enabled);
  let changed = 0;
  for (const p of targets) if (await setPluginEnabled(p.id, enabled)) changed++;
  return changed;
}

/** Numeric dotted-version comparison (`1.10.0` > `1.9.2`); pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split(".")
      .map((x) => parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The folder to install from for what the user picked; `.oiplugin` / `.zip` files are unpacked. */
async function packageFolder(backend: PluginsBackend, picked: string): Promise<string> {
  const lower = picked.toLowerCase();
  if (lower.endsWith(".oiplugin") || lower.endsWith(".zip")) return backend.unpackPackage(picked);
  // A folder's manifest stands for the folder.
  const manifest = /[\\/]plugin\.toml$/i.exec(picked);
  return manifest ? picked.slice(0, manifest.index) : picked;
}

/**
 * Asks for a plugin (a folder, its `plugin.toml`, or an `.oiplugin` / `.zip`
 * package file), shows what it may do, and installs it with the user's
 * consent. Returns the new plugin id.
 */
export async function installFromDisk(path?: string, packageFile = false): Promise<string | null> {
  const backend = pluginsBackend();
  let dir: string | null = path ?? null;
  try {
    dir ??= packageFile ? await backend.pickPackage() : await backend.pickFolder();
    // Package files are unpacked first; signed ones are checked on the install page.
    if (dir) dir = await packageFolder(backend, dir);
  } catch (e) {
    notifications().notify({
      group: "plugins",
      level: "error",
      title: packageFile ? "Could not open the package" : "Could not open the file picker",
      body: errorText(e),
    });
    return null;
  }
  if (!dir) return null;
  usePlugins.setState({ installing: true });
  let installed: string | null = null;
  try {
    const preview = await backend.previewInstall(dir);
    const consent = await askConsent({
      pluginId: preview.id,
      name: preview.name,
      version: preview.version,
      kind: "install",
      capabilities: preview.capabilities,
      unsigned: preview.unsigned,
      warnings: preview.warnings,
    });
    if (!consent) return null;
    const info = await backend.installDir(dir, consent);
    installed = info.status === "failed" ? null : info.id;
    notifications().notify({
      group: "plugins",
      level: info.status === "failed" ? "warning" : "info",
      title: `Installed ${info.name} ${info.version}`,
      body: info.status === "failed" ? (info.error ?? "The plugin failed to start.") : undefined,
    });
    return info.id;
  } catch (e) {
    notifications().notify({ group: "plugins", level: "error", title: "Could not install plugin", body: errorText(e) });
    return null;
  } finally {
    usePlugins.setState({ installing: false });
    await refreshPlugins();
    if (installed) await adoptIconTheme(installed);
  }
}

export async function selectPluginTheme(pluginId: string | null, themeId: string | null): Promise<void> {
  try {
    const activeTheme = await pluginsBackend().setTheme(pluginId, themeId);
    usePlugins.setState({ activeTheme });
  } catch (e) {
    notifications().notify({ group: "plugins", level: "error", title: "Could not apply theme", body: errorText(e) });
  }
}

/** Title of a plugin command from its UI contribution. */
export function commandTitle(pluginId: string, commandId: string): string {
  const item = usePlugins
    .getState()
    .ui.find((c) => c.point === "commands" && c.pluginId === pluginId && c.key === commandId);
  const title = (item?.decl as { title?: unknown } | undefined)?.title;
  return typeof title === "string" ? title : commandId;
}

/** Runs a plugin command from an action; failures become notifications. */
export async function runPluginCommand(pluginId: string, commandId: string, arg: string | null = null) {
  const title = commandTitle(pluginId, commandId);
  try {
    return await pluginsBackend().runCommand(pluginId, commandId, arg, editorContext());
  } catch (e) {
    await refreshPlugins();
    const status = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.status;
    // A trap disables the plugin and the backend already announced why; a
    // consent request opens its own dialog.
    const permission = (e as { kind?: string }).kind === "permissionDenied";
    if (status !== "failed" && !permission)
      notifications().notify({ group: "plugins", level: "error", title: `${title} failed`, body: errorText(e) });
    return null;
  }
}
