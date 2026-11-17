import { RangeSet, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  activeEditor,
  editorsFor,
  iconAreaSource,
  onEditorEvent,
  useEditorRegistry,
  type EditorDocContext,
} from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { locationItems, navigateTo } from "@/editor/lsp/navigation";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { invalidateNavigationProviders, registerNavigationProvider } from "@/editor/navigationProviders";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent, type Location, type ProjectInfo } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { projectFolder, useProject } from "@/platform/project";
import { gutterIconMarkup, type MenuItem } from "@/ui";
import { notifications, type MenuGroupContext } from "@/workbench/contributions";
import { callsEndpoint, controllerMethods, feignMethods, MAX_NAVIGATION_SOURCE, type FeignMethod } from "./feign";
import { clearRouteIndex, controllerIndex, isRouteSource, type ControllerTarget } from "./routeIndex";
import { isServiceConfiguration, loadServiceName, sourceModule } from "./serviceIdentity";
import styles from "../HttpClient.module.css";

export const GO_TO_FEIGN_ENDPOINT = "http.goToFeignEndpoint";
const serviceNames = new Map<string, Promise<string | null>>();
const changedSources = new Set<string>();
let epoch = 0;

function projectKey(project: ProjectInfo | null): string {
  return JSON.stringify([project?.root, project?.workspace?.projects, project?.trusted]);
}
function inside(project: ProjectInfo, path: string): boolean {
  const folder = projectFolder(project, path);
  return !!folder && isSameOrInside(path, folder.root);
}
async function read(path: string): Promise<string> {
  return editorsFor(path)[0]?.view.state.doc.toString() ?? (await call(commands.fsReadText(path)));
}
function invalidate() {
  epoch++;
  serviceNames.clear();
  clearRouteIndex();
  invalidateNavigationProviders();
}

function named(module: string): Promise<string | null> {
  let pending = serviceNames.get(module);
  if (!pending) {
    if (serviceNames.size >= 128) serviceNames.clear();
    pending = loadServiceName(module, { directory: (path) => call(commands.fsReadDir(path)), read });
    serviceNames.set(module, pending);
  }
  return pending;
}

function location(
  path: string,
  text: string,
  method: ReturnType<typeof controllerMethods>[number],
): Location & { name: string } {
  const doc = Text.of(text.split("\n"));
  const from = doc.lineAt(method.from),
    to = doc.lineAt(method.to);
  return {
    path,
    name: method.name,
    range: {
      start: { line: from.number - 1, col: method.from - from.from },
      end: { line: to.number - 1, col: method.to - to.from },
    },
  };
}

/** The index supplies candidates; current source/configuration supplies the navigation target. */
export async function feignTargets(source: string, client: FeignMethod): Promise<(Location & { name: string })[]> {
  const project = useProject.getState().project;
  if (!project?.trusted || !inside(project, source)) return [];
  const key = projectKey(project),
    started = epoch;
  const stale = () => started !== epoch || key !== projectKey(useProject.getState().project);
  const indexed = await controllerIndex(project.root);
  if (stale()) return [];
  const overlays = new Set(
    [...new Set([...changedSources, ...[...useEditorRegistry.getState().editors].map((e) => e.ctx.path)])]
      .filter((path) => isRouteSource(path) && inside(project, path))
      .slice(0, 256),
  );
  const currentText = new Map<string, string>();
  const candidates: ControllerTarget[] = indexed.filter((target) => !overlays.has(target.path));
  // Visible and recently edited source files include unsaved/new controllers
  // that the filesystem inventory has not seen yet. Never keep their full text.
  for (const path of overlays) {
    const text = await read(path).catch(() => null);
    if (text === null || text.length > MAX_NAVIGATION_SOURCE || stale()) continue;
    currentText.set(path, text);
    candidates.push(...controllerMethods(text).map((method) => ({ ...method, path })));
  }
  const paths = [
    ...new Set(candidates.filter((target) => callsEndpoint(client, target)).map((target) => target.path)),
  ].sort();
  const result: (Location & { name: string })[] = [];
  for (const path of paths.slice(0, 256)) {
    if (stale()) return [];
    const module = sourceModule(path);
    const folder = projectFolder(project, path);
    if (client.service && module && folder && isSameOrInside(module, folder.root)) {
      const name = await named(module);
      if (name && name !== client.service) continue;
    }
    const text = currentText.get(path) ?? (await read(path).catch(() => null));
    if (text === null || text.length > MAX_NAVIGATION_SOURCE) continue;
    for (const method of controllerMethods(text).filter((method) => callsEndpoint(client, method))) {
      const target = location(path, text, method);
      if (
        !result.some(
          (r) =>
            r.path === path &&
            r.range.start.line === target.range.start.line &&
            r.range.start.col === target.range.start.col,
        )
      )
        result.push(target);
      if (result.length === 256) break;
    }
    if (result.length === 256) break;
  }
  return stale() ? [] : result;
}

export function registerFeignNavigation(): () => void {
  invalidate();
  const unregister = registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || !["java", "kotlin"].includes(doc.language)) return null;
    const client = feignMethods(view.state.doc.toString()).find((c) =>
      c.links.some((l) => l.from <= offset && offset < l.to),
    );
    const link = client?.links.find((l) => l.from <= offset && offset < l.to);
    if (!client || !link) return null;
    return { ...link, targets: await feignTargets(doc.path, client) };
  });
  const filesystem = onIdeEvent("fsChanged", (event) => {
    if (
      [...event.created, ...event.modified, ...event.removed].some((p) => isRouteSource(p) || isServiceConfiguration(p))
    )
      invalidate();
  });
  const editors = onEditorEvent((event) => {
    if (
      !["docChanged", "docSaved", "docClosed"].includes(event.type) ||
      !event.path ||
      (!isRouteSource(event.path) && !isServiceConfiguration(event.path))
    )
      return;
    if (event.type === "docChanged" && isRouteSource(event.path)) {
      if (changedSources.size < 256) changedSources.add(event.path);
    } else if (event.type === "docClosed" || event.type === "docSaved") changedSources.delete(event.path);
    invalidate();
  });
  const projects = useProject.subscribe((state, previous) => {
    if (projectKey(state.project) === projectKey(previous.project)) return;
    changedSources.clear();
    invalidate();
  });
  return () => {
    unregister();
    filesystem();
    editors();
    projects();
    changedSources.clear();
    invalidate();
  };
}

export async function goToFeignEndpoint(arg?: unknown): Promise<void> {
  const requested = arg as { path?: unknown; offset?: unknown } | undefined;
  const editor = typeof requested?.path === "string" ? editorsFor(requested.path)[0] : activeEditor();
  if (!editor || editor.ctx.virtual || !["java", "kotlin"].includes(editor.ctx.language)) return;
  const view = editor.view,
    before = view.state.doc,
    started = epoch;
  const offset = typeof requested?.offset === "number" ? requested.offset : view.state.selection.main.head;
  const client = feignMethods(before.toString()).find((c) => c.from <= offset && offset <= c.to);
  if (!client) return;
  const stale = () =>
    view.state.doc !== before || started !== epoch || !editorsFor(editor.ctx.path).some((e) => e.view === view);
  try {
    const targets = await feignTargets(editor.ctx.path, client);
    if (stale()) return;
    if (!targets.length) {
      notifications().notify({ level: "info", title: tx("No matching Feign endpoint found"), key: "feign-navigation" });
    } else if (targets.length === 1) await navigateTo(targets[0]!);
    else {
      const items = await locationItems(targets);
      if (stale()) return;
      openPopup({
        kind: "list",
        title: tx("Choose Feign Endpoint"),
        anchor: caretAnchor(view, Math.min(offset, before.length)),
        items: items.map((item) => ({ ...item, run: () => (stale() ? undefined : item.run()) })),
      });
    }
  } catch (error) {
    notifications().notify({
      level: "error",
      title: tx("Cannot navigate to Feign endpoint"),
      body: String(error),
      key: "feign-navigation",
    });
  }
}

export function feignMenuItems(context: MenuGroupContext): MenuItem[] {
  const editor = activeEditor();
  if (!editor || editor.ctx.path !== context.paths[0]) return [];
  const offset = editor.view.state.selection.main.head;
  return feignMethods(editor.view.state.doc.toString()).some((c) => c.from <= offset && offset <= c.to)
    ? [{ kind: "action", action: GO_TO_FEIGN_ENDPOINT, icon: "arrow-right" }]
    : [];
}

type Mark = { pos: number; offset: number };
const setMarks = StateEffect.define<Mark[]>();
const marks = StateField.define<Mark[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarks)) return effect.value;
    return transaction.docChanged ? [] : value;
  },
});
class FeignMarker extends GutterMarker {
  constructor(
    readonly path: string,
    readonly offset: number,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof FeignMarker && other.path === this.path && other.offset === this.offset;
  }
  override toDOM(): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.runMarker ?? "";
    button.dataset.iconSource = "feign";
    button.title = tx("Go to Feign Endpoint");
    button.setAttribute("aria-label", button.title);
    button.innerHTML = gutterIconMarkup("arrow-right") ?? "";
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void executeAction(GO_TO_FEIGN_ENDPOINT, { path: this.path, offset: this.offset });
    };
    return button;
  }
}

export function feignEditorExtension(context: EditorDocContext): Extension {
  if (context.virtual || !["java", "kotlin"].includes(context.language)) return [];
  return [
    marks,
    ViewPlugin.fromClass(
      class {
        timer: ReturnType<typeof setTimeout> | undefined;
        constructor(readonly view: EditorView) {
          this.schedule(0);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule(400);
        }
        schedule(delay: number) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            const found = feignMethods(this.view.state.doc.toString()).map((c) => ({
              pos: this.view.state.doc.lineAt(c.nameFrom).from,
              offset: c.nameFrom,
            }));
            this.view.dispatch({
              effects: setMarks.of(found.filter((m, i) => found.findIndex((v) => v.pos === m.pos) === i)),
            });
          }, delay);
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    ),
    iconAreaSource.of({
      order: 31,
      markers: (view) =>
        RangeSet.of(
          view.state.field(marks).map((m) => new FeignMarker(context.path, m.offset).range(m.pos)),
          true,
        ),
    }),
  ];
}
