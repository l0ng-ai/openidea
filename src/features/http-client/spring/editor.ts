/**
 * Spring Web in Java / Kotlin editors: a gutter icon on every request mapping
 * and controller, context actions and editor menu items that generate the
 * requests into the `generated-requests.http` scratch and open it.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import {
  activeEditor,
  editorsFor,
  intentionProviders,
  useEditorRegistry,
  type ContributedIntention,
  type EditorDocContext,
  type TextEditorHandle,
} from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands, emitLocalIdeEvent, IpcError } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { editorService, notifications, type MenuGroupContext } from "@/workbench/contributions";
import { springAt, springControllers, type Controller, type Endpoint } from "./endpoints";
import { appendRequests, bodyLookup, findHost, renderRequest, skeleton, type SourceReader } from "./request";
import { parseSource } from "./source";
import styles from "../HttpClient.module.css";

export const SPRING_LANGUAGES = new Set(["java", "kotlin"]);
export const GENERATED_REQUESTS = "generated-requests.http";
export const GENERATE_REQUEST = "http.generateSpringRequest";
export const GENERATE_CONTROLLER_REQUESTS = "http.generateSpringControllerRequests";

const reader: SourceReader = {
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};

/** One request per endpoint (`paths[i]` picks another path of the mapping). */
export interface Target {
  endpoint: Endpoint;
  path?: string;
}

async function scratchFile(): Promise<{ path: string; created: boolean }> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  const dir = `${(await appDataDir()).replace(/[\\/]+$/, "")}/scratches`;
  const ignoreExisting = (e: unknown) => {
    if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
  };
  await call(commands.fsCreateDir(dir)).catch(ignoreExisting);
  const path = `${dir}/${GENERATED_REQUESTS}`;
  let created = true;
  await call(commands.fsCreateFile(path)).catch((e) => {
    ignoreExisting(e);
    created = false;
  });
  return { path, created };
}

/** The text editor of `path`, once the just opened tab has created it. */
function editorFor(path: string, timeoutMs = 5000): Promise<TextEditorHandle | null> {
  const find = () => editorsFor(path).find((x) => x === activeEditor()) ?? editorsFor(path)[0] ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (e: TextEditorHandle | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(e);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = useEditorRegistry.subscribe(() => {
      const e = find();
      if (e) done(e);
    });
  });
}

/** Renders `targets` of the source at `sourcePath`, appends them to the scratch and opens it at the first one. */
export async function generateRequests(sourcePath: string, text: string, targets: Target[]): Promise<void> {
  if (!targets.length) return;
  try {
    const root = useProject.getState().project?.root ?? null;
    const [host, lookup] = await Promise.all([
      findHost(sourcePath, root, reader),
      bodyLookup(
        sourcePath,
        parseSource(text),
        targets.map((t) => t.endpoint),
        reader,
      ),
    ]);
    const blocks = targets.map(({ endpoint, path }) =>
      renderRequest(endpoint, {
        host,
        path,
        body: endpoint.bodyType ? skeleton(endpoint.bodyType, lookup) : undefined,
      }),
    );
    const file = await scratchFile();
    if (file.created) emitLocalIdeEvent({ type: "fsChanged", created: [file.path], modified: [], removed: [] });
    await editorService().openFile(file.path, { focus: true });
    const e = await editorFor(file.path);
    if (!e) throw new Error(`${tx("Cannot open file")}: ${file.path}`);
    const { insert, from, caret } = appendRequests(e.view.state.doc.toString(), blocks);
    e.view.dispatch({
      changes: { from, insert },
      selection: { anchor: caret },
      effects: EditorView.scrollIntoView(caret, { y: "center" }),
      userEvent: "input",
    });
  } catch (err) {
    notifications().notify({
      level: "error",
      title: "Cannot generate the HTTP request",
      body: err instanceof Error ? err.message : String(err),
      key: "http-generate",
    });
  }
}

function endpointItems(sourcePath: string, text: string, e: Endpoint): MenuItem[] {
  const generate = (path?: string) => void generateRequests(sourcePath, text, [{ endpoint: e, path }]);
  return [
    e.paths.length > 1
      ? {
          label: "Generate Request in HTTP Client",
          icon: "file-http",
          submenu: e.paths.map((p) => ({ label: `${e.httpMethod} ${p}`, verbatim: true, run: () => generate(p) })),
        }
      : { label: "Generate Request in HTTP Client", icon: "file-http", run: () => generate() },
  ];
}

function controllerItems(sourcePath: string, text: string, c: Controller): MenuItem[] {
  return c.endpoints.length
    ? [
        {
          label: "Generate Requests for Controller",
          icon: "file-http",
          run: () =>
            void generateRequests(
              sourcePath,
              text,
              c.endpoints.map((endpoint) => ({ endpoint })),
            ),
        },
      ]
    : [];
}

/** Editor context menu items for the caret at `offset`: the generate actions (a path choice for several paths). */
export function springMenuItems(sourcePath: string, text: string, offset: number): MenuItem[] {
  const { controller, endpoint } = springAt(springControllers(text), offset);
  const items: MenuItem[] = [];
  if (endpoint)
    items.push(
      endpoint.paths.length > 1
        ? endpointItems(sourcePath, text, endpoint)[0]!
        : { kind: "action", action: GENERATE_REQUEST, icon: "file-http" },
    );
  if (controller?.endpoints.length)
    items.push({ kind: "action", action: GENERATE_CONTROLLER_REQUESTS, icon: "file-http" });
  return items;
}

export function menuGroupItems(ctx: MenuGroupContext): MenuItem[] {
  const path = ctx.paths[0];
  if (!path || ctx.text === undefined || ctx.line === undefined || !/\.(java|kt)$/.test(path)) return [];
  // The actions work at the caret: only the active editor's menu offers them.
  const e = activeEditor();
  if (!e || e.ctx.path !== path || !SPRING_LANGUAGES.has(e.ctx.language)) return [];
  return springMenuItems(path, ctx.text, e.view.state.selection.main.head);
}

/** The generate actions at the caret of the active editor. */
export async function generateAtCaret(scope: "endpoint" | "controller"): Promise<void> {
  const e = activeEditor();
  if (!e || !SPRING_LANGUAGES.has(e.ctx.language)) return;
  const text = e.view.state.doc.toString();
  const { controller, endpoint } = springAt(springControllers(text), e.view.state.selection.main.head);
  const endpoints = scope === "endpoint" ? (endpoint ? [endpoint] : []) : (controller?.endpoints ?? []);
  if (!endpoints.length) {
    notifications().notify({
      level: "info",
      title: scope === "endpoint" ? "No Spring request mapping at the caret" : "No Spring controller at the caret",
      key: "http-generate",
    });
    return;
  }
  await generateRequests(
    e.ctx.path,
    text,
    endpoints.map((x) => ({ endpoint: x })),
  );
}

// --- gutter ----------------------------------------------------------------------

interface Mark {
  pos: number;
  /** Endpoint key or the controller's name. */
  key: string;
  title: string;
  items: (path: string, text: string) => MenuItem[];
}

const setMarks = StateEffect.define<Mark[]>();

const marksField = StateField.define<Mark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
  },
});

function computeMarks(state: EditorState): Mark[] {
  const doc = state.doc;
  const marks: Mark[] = [];
  const lineStart = (offset: number) => doc.lineAt(Math.min(offset, doc.length)).from;
  for (const c of springControllers(doc.toString())) {
    if (c.endpoints.length)
      marks.push({
        pos: lineStart(c.offset),
        key: `class:${c.name}`,
        title: "Generate Requests for Controller",
        items: (path, text) => controllerItems(path, text, c),
      });
    for (const e of c.endpoints)
      marks.push({
        pos: lineStart(e.offset),
        key: `${e.httpMethod} ${e.paths.join(",")}`,
        title: `${e.httpMethod} ${e.paths[0] ?? "/"}`,
        items: (path, text) => endpointItems(path, text, e),
      });
  }
  // One icon per line (the first wins).
  return marks.filter((m, i) => marks.findIndex((x) => x.pos === m.pos) === i);
}

class SpringMarker extends GutterMarker {
  constructor(readonly mark: Mark) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof SpringMarker && other.mark.key === this.mark.key && other.mark.title === this.mark.title;
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    el.title = this.mark.title;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.mark.title);
    el.innerHTML = gutterIconMarkup("file-http") ?? "";
    return el;
  }
}

const DEBOUNCE = 400;

export function springEditorExtension(ctx: EditorDocContext): Extension {
  if (!SPRING_LANGUAGES.has(ctx.language) || ctx.virtual || isVirtualUri(ctx.path)) return [];
  const path = ctx.path;
  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(DEBOUNCE);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const found = computeMarks(this.view.state);
          const cur = this.view.state.field(marksField);
          const same =
            cur.length === found.length && cur.every((m, i) => m.pos === found[i]!.pos && m.key === found[i]!.key);
          if (!same) this.view.dispatch({ effects: setMarks.of(found) });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  const intentions = (view: EditorView): ContributedIntention[] => {
    // Only files that have mappings (the gutter found some) are parsed again here.
    if (!view.state.field(marksField, false)?.length) return [];
    const text = view.state.doc.toString();
    const { controller, endpoint } = springAt(springControllers(text), view.state.selection.main.head);
    const out: ContributedIntention[] = [];
    if (endpoint)
      out.push({
        id: GENERATE_REQUEST,
        label: "Generate Request in HTTP Client",
        icon: "file-http",
        run: () => generateRequests(path, text, [{ endpoint }]),
      });
    if (controller?.endpoints.length)
      out.push({
        id: GENERATE_CONTROLLER_REQUESTS,
        label: "Generate Requests for Controller",
        icon: "file-http",
        run: () =>
          generateRequests(
            path,
            text,
            controller.endpoints.map((e) => ({ endpoint: e })),
          ),
      });
    return out;
  };
  return [
    marksField,
    detector,
    intentionProviders.of(intentions),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-spring`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(marksField).map((m) => new SpringMarker(m).range(m.pos)),
          true,
        ),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const mark = view.state.field(marksField).find((m) => m.pos === block.from);
          if (!mark || (event as MouseEvent).button !== 0) return false;
          const el = (event.target as HTMLElement).closest?.(`.${styles.runMarker}`) as HTMLElement | null;
          const rect = (el ?? (event.target as HTMLElement)).getBoundingClientRect();
          event.preventDefault();
          showContextMenu({ x: rect.left, y: rect.bottom + 2 }, mark.items(path, view.state.doc.toString()));
          return true;
        },
      },
    }),
  ];
}
