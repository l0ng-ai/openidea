/**
 * Code navigation providers contributed by plugins
 * (`[[contributes.code-navigation]]` in `plugin.toml`): one provider per
 * declaration of every enabled plugin. For each open file its `files` globs
 * cover, the IDE runs `plugin_navigation` when the file opens or is saved
 * (debounced) and when a file the last answer reported changes, and feeds the
 * links and markers to the store; the answer's diagnostics go to the Problems
 * view.
 */
import type { CodeNavigationDecl, Diagnostic, PluginInfo, PluginNavDiagnostic, PluginNavigation } from "@/bindings";
import { onEditorEvent, useEditorRegistry } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { publishLocalDiagnostics } from "@/platform/localDiagnostics";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { notifications } from "@/workbench/contributions";
import { usePlugins } from "../plugins/store";
import { dependsOn, matchesFile } from "./model";
import { clearProvider, setFileNavigation } from "./store";

const RUN_DELAY = 300;

export function providerId(pluginId: string, index: number): string {
  return `code-navigation:${pluginId}:${index}`;
}

/** The plugin's diagnostics as Problems view entries, grouped by file (default: `path`, the file asked). */
export function toDiagnostics(
  items: readonly PluginNavDiagnostic[],
  source: string,
  path: string,
): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  for (const d of items) {
    const file = d.file || path;
    const pos = { line: Math.max(0, d.line - 1), col: 0 };
    const list = out.get(file) ?? [];
    list.push({ range: { start: pos, end: pos }, severity: "warning", message: d.message, source, code: null });
    out.set(file, list);
  }
  return out;
}

export interface NavigationProvider {
  id: string;
  /** Starts following `path` when the declaration covers it; returns whether it does. */
  open(path: string, root: string): boolean;
  /** Stops following `path` and forgets what was reported for it. */
  close(path: string): void;
  /** Re-runs for the followed files that `path` (saved or changed on disk) affects; returns whether any did. */
  changed(path: string, root: string): boolean;
  /** Forgets every file (the project changed). */
  reset(): void;
  dispose(): void;
}

/** One declaration of one plugin, as a provider with its own state. */
export function navigationProvider(
  plugin: Pick<PluginInfo, "id" | "name">,
  index: number,
  decl: CodeNavigationDecl,
  run: (path: string) => Promise<PluginNavigation | null> = (path) =>
    call(commands.pluginNavigation(plugin.id, index, path)),
): NavigationProvider {
  const id = providerId(plugin.id, index);
  /** Followed file → files the last answer read, and files its diagnostics were published for. */
  const followed = new Map<string, { deps: string[]; diagnosed: Set<string>; seq: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const publish = (entry: { diagnosed: Set<string> }, byFile: Map<string, Diagnostic[]>) => {
    for (const file of entry.diagnosed) if (!byFile.has(file)) publishLocalDiagnostics(file, id, []);
    for (const [file, items] of byFile) publishLocalDiagnostics(file, id, items);
    entry.diagnosed = new Set(byFile.keys());
  };

  const load = async (path: string) => {
    const entry = followed.get(path);
    if (!entry || !isTauri()) return;
    const mine = ++entry.seq;
    try {
      const nav = await run(path);
      if (followed.get(path) !== entry || entry.seq !== mine) return;
      entry.deps = nav?.files ?? [];
      setFileNavigation(id, path, nav ? { links: nav.links ?? [], markers: nav.markers ?? [] } : null);
      publish(entry, toDiagnostics(nav?.diagnostics ?? [], plugin.name, path));
    } catch (e) {
      if (followed.get(path) !== entry || entry.seq !== mine) return;
      setFileNavigation(id, path, null);
      notifications().notify({
        level: "warning",
        title: tx`Code navigation of ${plugin.name} failed`,
        body: e instanceof Error ? e.message : String(e),
        key: id,
        group: "plugins",
      });
    }
  };
  const schedule = (path: string) => {
    const t = timers.get(path);
    if (t) clearTimeout(t);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        void load(path);
      }, RUN_DELAY),
    );
  };
  const close = (path: string) => {
    const entry = followed.get(path);
    if (!entry) return;
    followed.delete(path);
    const t = timers.get(path);
    if (t) clearTimeout(t);
    timers.delete(path);
    setFileNavigation(id, path, null);
    publish(entry, new Map());
  };
  return {
    id,
    open: (path, root) => {
      if (!matchesFile(decl, root, path)) return false;
      if (!followed.has(path)) followed.set(path, { deps: [], diagnosed: new Set(), seq: 0 });
      schedule(path);
      return true;
    },
    close,
    changed: (path, root) => {
      let any = false;
      for (const [file, entry] of followed)
        if (file === path || dependsOn(entry.deps, path)) {
          if (file !== path && !matchesFile(decl, root, file)) continue;
          schedule(file);
          any = true;
        }
      return any;
    },
    reset: () => {
      for (const path of [...followed.keys()]) close(path);
    },
    dispose: () => {
      for (const path of [...followed.keys()]) close(path);
      clearProvider(id);
    },
  };
}

/** Paths of the files shown in text editors (split panes dedupe), no virtual documents. */
function openFiles(): string[] {
  const paths = new Set<string>();
  for (const e of useEditorRegistry.getState().editors)
    if (!e.ctx.virtual && !isVirtualUri(e.ctx.path)) paths.add(e.ctx.path);
  return [...paths];
}

/** Keeps one provider per `[[contributes.code-navigation]]` of the enabled plugins; returns a disposer. */
export function installNavigationProviders(): () => void {
  const active = new Map<string, NavigationProvider>();
  /** path → editors showing it. */
  const open = new Map<string, number>();
  let root = useProject.getState().project?.root ?? null;
  const sync = (plugins: readonly PluginInfo[]) => {
    const wanted = new Map<string, { plugin: PluginInfo; index: number; decl: CodeNavigationDecl }>();
    for (const p of plugins)
      if (p.enabled && p.hasCode && p.status !== "failed")
        p.codeNavigation.forEach((decl, index) => wanted.set(providerId(p.id, index), { plugin: p, index, decl }));
    for (const [id, provider] of active)
      if (!wanted.has(id)) {
        provider.dispose();
        active.delete(id);
      }
    for (const [id, { plugin, index, decl }] of wanted)
      if (!active.has(id)) {
        const provider = navigationProvider(plugin, index, decl);
        active.set(id, provider);
        if (root) for (const path of open.keys()) provider.open(path, root);
      }
  };
  for (const path of openFiles()) open.set(path, (open.get(path) ?? 0) + 1);
  sync(usePlugins.getState().plugins);
  const unsubPlugins = usePlugins.subscribe((s, prev) => {
    if (s.plugins !== prev.plugins) sync(s.plugins);
  });
  const unsubProject = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    if (r === root) return;
    root = r;
    for (const provider of active.values()) provider.reset();
    if (root) for (const path of open.keys()) for (const provider of active.values()) provider.open(path, root);
  });
  const changed = (paths: readonly string[]) => {
    if (!root) return;
    for (const provider of active.values()) for (const p of paths) provider.changed(p, root);
  };
  const unsubFs = onIdeEvent("fsChanged", (e) => changed([...e.created, ...e.modified, ...e.removed]));
  const unsubEditor = onEditorEvent((e) => {
    switch (e.type) {
      case "docOpened": {
        if (isVirtualUri(e.path)) return;
        const n = (open.get(e.path) ?? 0) + 1;
        open.set(e.path, n);
        if (n === 1 && root) for (const provider of active.values()) provider.open(e.path, root);
        return;
      }
      case "docClosed": {
        const n = (open.get(e.path) ?? 0) - 1;
        if (n > 0) open.set(e.path, n);
        else {
          open.delete(e.path);
          for (const provider of active.values()) provider.close(e.path);
        }
        return;
      }
      case "docSaved":
        changed([e.path]);
        return;
    }
  });
  return () => {
    unsubPlugins();
    unsubProject();
    unsubFs();
    unsubEditor();
    for (const provider of active.values()) provider.dispose();
    active.clear();
  };
}
