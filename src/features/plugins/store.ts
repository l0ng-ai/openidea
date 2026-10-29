/** Installed plugins, the selected plugin theme, and the operations on them. */
import { create } from "zustand";
import type { ActiveTheme, CatalogPlugin, PluginInfo } from "@/bindings";
import { notifications } from "@/workbench/contributions";
import { pluginsBackend } from "./backend";

export const SETTINGS_PAGE_ID = "plugins";

interface PluginsState {
  plugins: PluginInfo[];
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
}

export const usePlugins = create<PluginsState>(() => ({
  plugins: [],
  activeTheme: null,
  loaded: false,
  loading: false,
  error: null,
  busy: {},
  installing: false,
  catalog: null,
  catalogError: null,
}));

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let generation = 0;

export async function refreshPlugins(): Promise<void> {
  const gen = ++generation;
  usePlugins.setState({ loading: true });
  try {
    const snapshot = await pluginsBackend().list();
    if (gen !== generation) return;
    usePlugins.setState({
      plugins: snapshot.plugins,
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

export function setPluginEnabled(id: string, enabled: boolean): Promise<boolean> {
  return withBusy(id, `Could not ${enabled ? "enable" : "disable"} ${nameOf(id)}`, () =>
    pluginsBackend().setEnabled(id, enabled),
  );
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

export async function refreshCatalog(): Promise<void> {
  try {
    usePlugins.setState({ catalog: await pluginsBackend().catalog(), catalogError: null });
  } catch (e) {
    usePlugins.setState({ catalog: [], catalogError: errorText(e) });
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

/** Asks for a plugin folder (containing plugin.toml) and installs it. Returns the new plugin id. */
export async function installFromDisk(path?: string): Promise<string | null> {
  const backend = pluginsBackend();
  let dir: string | null = path ?? null;
  try {
    dir ??= await backend.pickFolder();
  } catch (e) {
    notifications().notify({
      group: "plugins",
      level: "error",
      title: "Could not open the folder picker",
      body: errorText(e),
    });
    return null;
  }
  if (!dir) return null;
  usePlugins.setState({ installing: true });
  try {
    const info = await backend.installDir(dir);
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

/** Runs a plugin command from an action; failures become notifications. */
export async function runPluginCommand(pluginId: string, commandId: string, arg: string | null = null) {
  const plugin = usePlugins.getState().plugins.find((p) => p.id === pluginId);
  const title = plugin?.commands.find((c) => c.id === commandId)?.title ?? commandId;
  try {
    return await pluginsBackend().runCommand(pluginId, commandId, arg);
  } catch (e) {
    await refreshPlugins();
    // A trap disables the plugin and the backend already announced why.
    const failed = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.status === "failed";
    if (!failed)
      notifications().notify({ group: "plugins", level: "error", title: `${title} failed`, body: errorText(e) });
    return null;
  }
}
