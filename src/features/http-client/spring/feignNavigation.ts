import { RangeSet, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  activeEditor,
  editorsFor,
  iconAreaSource,
  invalidateNavigationProviders,
  onEditorEvent,
  registerNavigationProvider,
  useEditorRegistry,
  type EditorDocContext,
} from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { locationItems, navigateTo } from "@/editor/lsp/navigation";
import { caretAnchor, openPopup, type ListPopupItem } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent, type Location, type ProjectInfo } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { projectFolder, relativePath, useProject } from "@/platform/project";
import { gutterIconMarkup, type MenuItem } from "@/ui";
import { notifications, type MenuGroupContext } from "@/workbench/contributions";
import {
  callsEndpoint,
  controllerMethods,
  feignMethods,
  MAX_NAVIGATION_SOURCE,
  type FeignMethod,
  type HttpShape,
  type MappedMethod,
} from "./feign";
import { clearRouteIndex, controllerIndex, feignClientIndex, isRouteSource } from "./routeIndex";
import { isServiceConfiguration, loadServiceName, sourceModule } from "./serviceIdentity";
import styles from "../HttpClient.module.css";

export const GO_TO_FEIGN_ENDPOINT = "http.goToFeignEndpoint";
export const FIND_FEIGN_CLIENTS = "http.findFeignClients";
const TARGET_LIMIT = 256;
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
/** Forgets resolved targets and service names; the disk route index stays. */
function refresh() {
  epoch++;
  serviceNames.clear();
  invalidateNavigationProviders();
}
function invalidate() {
  refresh();
  clearRouteIndex();
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

interface FeignLocation extends Location {
  name: string;
  possible?: boolean;
}

function location(path: string, doc: Text, method: MappedMethod): FeignLocation {
  const from = doc.lineAt(method.nameFrom);
  return {
    path,
    name: method.name,
    range: {
      start: { line: from.number - 1, col: method.nameFrom - from.from },
      end: { line: from.number - 1, col: method.nameTo - from.from },
    },
  };
}

function lookupScope(source: string) {
  const project = useProject.getState().project;
  if (!project?.trusted || !inside(project, source)) return null;
  const key = projectKey(project),
    started = epoch;
  return { project, stale: () => started !== epoch || key !== projectKey(useProject.getState().project) };
}

function controllerService(project: ProjectInfo, path: string): Promise<string | null> {
  const module = sourceModule(path);
  const folder = projectFolder(project, path);
  return module && folder && isSameOrInside(module, folder.root) ? named(module) : Promise.resolve(null);
}

/** The disk index narrows the search. Open and recently edited files may contain new
 * mappings, and the current source supplies the identifier range we actually open. */
async function* currentMappings<T extends MappedMethod>(
  scope: NonNullable<ReturnType<typeof lookupScope>>,
  indexedPaths: string[],
  parse: (text: string) => T[],
  matches: (method: T) => boolean,
) {
  const paths = new Set([...new Set(indexedPaths)].slice(0, TARGET_LIMIT));
  const overlays = new Set([...changedSources, ...[...useEditorRegistry.getState().editors].map((e) => e.ctx.path)]);
  for (const path of [...overlays].filter((p) => isRouteSource(p) && inside(scope.project, p)).slice(0, TARGET_LIMIT))
    paths.add(path);
  for (const path of [...paths].sort()) {
    if (scope.stale()) return;
    const text = await read(path).catch(() => null);
    if (scope.stale()) return;
    if (text === null || text.length > MAX_NAVIGATION_SOURCE) continue;
    const methods = parse(text).filter(matches);
    if (methods.length) yield { path, doc: Text.of(text.split("\n")), methods };
  }
}

export async function feignTargets(source: string, client: FeignMethod): Promise<FeignLocation[]> {
  const scope = lookupScope(source);
  if (!scope) return [];
  const indexed = await controllerIndex(scope.project.root);
  if (scope.stale()) return [];
  const matches = (method: HttpShape) => callsEndpoint(client, method);
  const paths = indexed
    .filter(matches)
    .map((entry) => entry.path)
    .sort();
  const result: FeignLocation[] = [];
  for await (const { path, doc, methods } of currentMappings(scope, paths, controllerMethods, matches)) {
    const service = client.service && (await controllerService(scope.project, path));
    if (service && service !== client.service) continue;
    for (const method of methods) {
      result.push(location(path, doc, method));
      if (result.length === TARGET_LIMIT) break;
    }
    if (result.length === TARGET_LIMIT) break;
  }
  return scope.stale() ? [] : result;
}

export async function feignClients(source: string, controller: MappedMethod): Promise<FeignLocation[]> {
  const scope = lookupScope(source);
  if (!scope) return [];
  const [indexed, service] = await Promise.all([
    feignClientIndex(scope.project.root),
    controllerService(scope.project, source),
  ]);
  if (scope.stale()) return [];
  const matches = (client: HttpShape & { service: string | null }) =>
    (!service || !client.service || client.service === service) && callsEndpoint(client, controller);
  const candidates = indexed.filter(matches);
  // Keep named clients ahead of ambiguous ones when the candidate limit is reached.
  const paths = [
    ...candidates
      .filter((entry) => service && entry.service)
      .map((entry) => entry.path)
      .sort(),
    ...candidates
      .filter((entry) => !service || !entry.service)
      .map((entry) => entry.path)
      .sort(),
  ];
  const confirmed: FeignLocation[] = [],
    possible: FeignLocation[] = [];
  for await (const { path, doc, methods } of currentMappings(scope, paths, feignMethods, matches)) {
    for (const method of methods) {
      if (service && method.service) confirmed.push(location(path, doc, method));
      else if (possible.length < TARGET_LIMIT) possible.push({ ...location(path, doc, method), possible: true });
      if (confirmed.length === TARGET_LIMIT) break;
    }
    if (confirmed.length === TARGET_LIMIT) break;
  }
  return scope.stale() ? [] : [...confirmed, ...possible].slice(0, TARGET_LIMIT);
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
    if (event.type === "docChanged") {
      if (isRouteSource(event.path) && changedSources.size < 256) changedSources.add(event.path);
      // Unsaved text is overlaid on the disk index: typing must not rescan the project.
      refresh();
      return;
    }
    changedSources.delete(event.path);
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

function clientItem(target: FeignLocation): ListPopupItem {
  const project = useProject.getState().project;
  const folder = projectFolder(project, target.path);
  const path = folder ? relativePath(folder.root, target.path) : target.path;
  const display = project?.workspace && folder ? `${folder.name}/${path}` : path;
  const { line, col } = target.range.start;
  return {
    id: `${target.path}:${line}:${col}`,
    label: target.name,
    detail: `${display}:${line + 1}`,
    preview: target.possible ? tx("Possible match") : undefined,
    symbol: "method",
    location: { path: target.path, line },
    run: () => navigateTo(target),
  };
}

export async function navigateFeign(direction: "endpoint" | "clients", arg?: unknown): Promise<void> {
  const requested = arg as { path?: unknown; offset?: unknown } | undefined;
  const editor = typeof requested?.path === "string" ? editorsFor(requested.path)[0] : activeEditor();
  if (!editor || editor.ctx.virtual || !["java", "kotlin"].includes(editor.ctx.language)) return;
  const scope = lookupScope(editor.ctx.path);
  if (!scope) return;
  const view = editor.view,
    before = view.state.doc;
  const offset = typeof requested?.offset === "number" ? requested.offset : view.state.selection.main.head;
  const atCaret = (m: MappedMethod) => m.from <= offset && offset <= m.to;
  const stale = () =>
    view.state.doc !== before || scope.stale() || !editorsFor(editor.ctx.path).some((e) => e.view === view);
  try {
    let targets: FeignLocation[];
    if (direction === "clients") {
      const controller = controllerMethods(before.toString()).find(atCaret);
      if (!controller) {
        notifications().notify({
          level: "info",
          title: tx("No Spring request mapping at the caret"),
          key: "feign-navigation",
        });
        return;
      }
      targets = await feignClients(editor.ctx.path, controller);
    } else {
      const client = feignMethods(before.toString()).find(atCaret);
      if (!client) return;
      targets = await feignTargets(editor.ctx.path, client);
    }
    if (stale()) return;
    if (!targets.length) {
      notifications().notify({
        level: "info",
        title: direction === "clients" ? tx("No matching Feign clients found") : tx("No matching Feign endpoint found"),
        key: "feign-navigation",
      });
    } else if (targets.length === 1 && !targets[0]!.possible) await navigateTo(targets[0]!);
    else {
      const items = direction === "clients" ? targets.map(clientItem) : await locationItems(targets);
      if (stale()) return;
      openPopup({
        kind: "list",
        title: direction === "clients" ? tx("Feign Clients") : tx("Choose Feign Endpoint"),
        anchor: caretAnchor(view, Math.min(offset, before.length)),
        items: items.map((item) => ({ ...item, run: () => (stale() ? undefined : item.run()) })),
      });
    }
  } catch (error) {
    if (!stale())
      notifications().notify({
        level: "error",
        title: direction === "clients" ? tx("Cannot find Feign clients") : tx("Cannot navigate to Feign endpoint"),
        body: String(error),
        key: "feign-navigation",
      });
  }
}

export function findClientItems(path: string, text: string, offset: number): MenuItem[] {
  if (!lookupScope(path) || !controllerMethods(text).some((method) => method.nameFrom === offset)) return [];
  return [{ kind: "action", action: FIND_FEIGN_CLIENTS, icon: "search", arg: { path, offset } }];
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
