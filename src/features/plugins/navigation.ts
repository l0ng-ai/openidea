/** Background navigation indexing. Opening a project discovers files once;
 * edits and filesystem events then enqueue only affected paths. */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { registerEditorContribution, whenSynced } from "@/editor/api";
import { invalidateNavigationProviders, registerNavigationProvider } from "@/editor/navigationProviders";
import { docOf } from "@/editor/lsp/lsp";
import { offsetToPos, rangeToOffsets } from "@/editor/lsp/positions";
import { call, commands, isCancelled, isTauri, nextRequestId, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications, registerDocumentIndexSync } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { pluginsBackend } from "./backend";
import { invalidatePluginMarkers } from "./markerStore";
import { usePlugins } from "./store";

export function startPluginNavigation(): () => void {
  if (!isTauri()) return () => {};
  let generation = 0;
  let disposed = false;
  let running = false;
  let request: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<string>();
  const dirty = new Set<string>();
  const views = new Map<EditorView, string>();
  let discovered = false;
  let discovering = false;
  const known = new Set<string>();
  let signature = "";
  let reportedError = false;
  function report(error: unknown) {
    console.warn("Plugin navigation", error);
    if (reportedError) return;
    reportedError = true;
    notifications().notify({
      group: "plugins",
      level: "warning",
      title: "Plugin navigation indexing incomplete",
      body: String(error),
    });
  }
  let fileExtensions = new Set<string>();
  const extensions = () => fileExtensions;
  const eligible = (path: string) => extensions().has(path.split(".").pop() ?? "");
  const ready = () =>
    !disposed &&
    !!useProject.getState().project?.trusted &&
    usePlugins
      .getState()
      .plugins.some(
        (p) =>
          (p.status === "active" || p.status === "inactive") &&
          p.contributions.some((c) => c.point === "documentIndexers"),
      );
  const notify = () => invalidateNavigationProviders();

  let flushing: Promise<void> | null = null;
  function flush(): Promise<void> {
    if (flushing) return flushing;
    const task = runFlush().finally(() => {
      if (flushing === task) flushing = null;
    });
    flushing = task;
    return task;
  }
  async function runFlush() {
    timer = undefined;
    if (running || !ready() || !pending.size) return;
    running = true;
    const at = generation;
    const paths = [...pending].slice(0, 8);
    paths.forEach((p) => pending.delete(p));
    const id = nextRequestId();
    request = id;
    try {
      await Promise.all([...views].filter(([, p]) => paths.includes(p)).map(([v]) => whenSynced(v)));
      if (at !== generation || !ready()) return;
      await call(commands.pluginNavigationInvalidate(paths));
      await call(commands.pluginNavigationIndex(paths, id));
      if (at === generation) {
        paths.forEach((p) => {
          if (!pending.has(p)) dirty.delete(p);
        });
        notify();
      }
    } catch (error) {
      if (at === generation && isCancelled(error)) paths.forEach((p) => pending.add(p));
      else if (at === generation) report(error);
    } finally {
      request = null;
      running = false;
      if (pending.size && ready()) timer = setTimeout(() => void flush(), 20);
    }
  }
  function queue(paths: string[], priority = false) {
    const matching = paths.filter(eligible);
    if (!matching.length || !ready()) return;
    invalidatePluginMarkers(matching);
    matching.forEach((p) => dirty.add(p));
    pending = priority ? new Set([...matching, ...pending]) : new Set([...pending, ...matching]);
    notify();
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), priority ? 150 : 30);
  }
  let discovery: Promise<void> | null = null;
  function discover(): Promise<void> {
    if (discovery) return discovery;
    const task = runDiscovery().finally(() => {
      if (discovery === task) discovery = null;
    });
    discovery = task;
    return task;
  }
  async function runDiscovery() {
    if (!ready() || discovered || discovering) return;
    discovering = true;
    const at = generation;
    try {
      const inventory = await call(commands.pluginNavigationFiles());
      if (at !== generation) return;
      fileExtensions = new Set(inventory.extensions);
      discovered = !inventory.indexing;
      const fresh = inventory.paths.filter((p) => !known.has(p));
      inventory.paths.forEach((p) => known.add(p));
      queue(fresh);
      queue([...views.values()], true);
    } catch (error) {
      discovered = false;
      report(error);
    } finally {
      if (at === generation) discovering = false;
      if (!discovered && ready() && at === generation) setTimeout(() => void discover(), 1000);
    }
  }
  function reset() {
    invalidatePluginMarkers();
    generation++;
    if (request !== null) void commands.cancelRequest(request);
    clearTimeout(timer);
    pending.clear();
    dirty.clear();
    known.clear();
    discovered = false;
    discovering = false;
    discovery = null;
    reportedError = false;
    notify();
    if (ready())
      void call(commands.pluginNavigationInvalidate(null))
        .then(discover)
        .catch(() => {});
  }
  const offs = [
    registerDocumentIndexSync(async (path) => {
      if (!ready()) return;
      const root = useProject.getState().project!.root;
      if (!path.startsWith(root.endsWith("/") ? root : `${root}/`)) return;
      const at = generation;
      await discover();
      if (!eligible(path)) return;
      while (ready() && at === generation && (pending.size || flushing)) {
        clearTimeout(timer);
        await flush();
      }
      if (at !== generation || !discovered || dirty.size) {
        throw new Error(tx`Plugin indexes are still updating; try again shortly`);
      }
    }),
    pluginsBackend().onEvent((event) => {
      if (event.type === "documentIndexesChanged") reset();
    }),
    registerNavigationProvider(async (view, offset) => {
      const doc = docOf(view);
      if (!ready() || !doc || doc.virtual || !eligible(doc.path) || dirty.has(doc.path)) return null;
      const before = view.state.doc;
      await whenSynced(view);
      const result = await call(commands.pluginNavigationGoto(doc.doc, offsetToPos(before, offset)));
      if (!result || view.state.doc !== before) return null;
      return { ...rangeToOffsets(before, result.range), targets: result.targets.filter((t) => !dirty.has(t.path)) };
    }),
    registerEditorContribution({
      id: "plugins.navigation",
      extensions: (ctx) =>
        ctx.virtual || ctx.doc < 0
          ? []
          : ViewPlugin.fromClass(
              class {
                constructor(readonly view: EditorView) {
                  views.set(view, ctx.path);
                  queue([ctx.path], true);
                }
                update(update: ViewUpdate) {
                  if (update.docChanged) queue([ctx.path], true);
                }
                destroy() {
                  views.delete(this.view);
                  queue([ctx.path]);
                }
              },
            ),
    }),
    onIdeEvent("fsChanged", (event) => {
      const paths = [...event.created, ...event.modified, ...event.removed];
      queue(paths);
    }),
    onIdeEvent("indexState", (event) => {
      if (!event.indexing) void discover();
    }),
    onIdeEvent("projectRootsChanged", () => reset()),
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root || s.project?.trusted !== prev.project?.trusted) reset();
    }),
    usePlugins.subscribe((state) => {
      const next = state.plugins
        .map(
          (p) =>
            `${p.id}:${p.version}:${p.status === "active" || p.status === "inactive" ? "live" : p.status}:${JSON.stringify(p.contributions)}`,
        )
        .join("|");
      if (next !== signature) {
        signature = next;
        reset();
      }
    }),
  ];
  // Index completion events may predate feature activation; querying the current
  // inventory now is safe, and an incomplete inventory is retried on IndexState.
  signature = usePlugins
    .getState()
    .plugins.map(
      (p) =>
        `${p.id}:${p.version}:${p.status === "active" || p.status === "inactive" ? "live" : p.status}:${JSON.stringify(p.contributions)}`,
    )
    .join("|");
  void discover();
  return () => {
    disposed = true;
    reset();
    offs.reverse().forEach((off) => off());
    views.clear();
  };
}
