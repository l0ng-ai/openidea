/**
 * Endpoints in editors: a gutter icon on every line that declares endpoints
 * (whatever the framework: the lines come from the registered providers), a
 * menu per line with "Generate Request in HTTP Client" and "Show in Endpoints"
 * for each endpoint, the same as context actions at the caret.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import { activeEditor, intentionProviders, type ContributedIntention, type EditorDocContext } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { isVirtualUri } from "@/platform/virtualDocs";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { notifications, toolWindowService, type MenuGroupContext } from "@/workbench/contributions";
import { generateIntoScratch, renderRequestBlock } from "../http-client/generate";
import styles from "../http-client/HttpClient.module.css";
import { ENDPOINTS_WINDOW } from "./EndpointsView";
import type { Endpoint } from "./model";
import { selectEndpoint, useEndpoints } from "./store";

export const GENERATE_REQUEST = "endpoints.generateRequest";
export const SHOW_IN_ENDPOINTS = "endpoints.showAtCaret";

/** Writes the requests of `endpoints` into the generated-requests scratch. */
export async function generateRequests(endpoints: Endpoint[]): Promise<void> {
  if (!endpoints.length) return;
  try {
    await generateIntoScratch(endpoints.map((e) => renderRequestBlock(e.request)));
  } catch (err) {
    notifications().notify({
      level: "error",
      title: "Cannot generate the HTTP request",
      body: err instanceof Error ? err.message : String(err),
      key: "http-generate",
    });
  }
}

export function showInEndpoints(e: Endpoint) {
  selectEndpoint(e.id);
  toolWindowService().show(ENDPOINTS_WINDOW, true);
}

/** The endpoints declared on `line` (1-based) of `file`. */
export function endpointsAt(endpoints: readonly Endpoint[], file: string, line: number): Endpoint[] {
  return endpoints.filter((e) => e.file === file && e.line === line);
}

/** 1-based lines of `file` that declare endpoints, ascending. */
export function endpointLines(endpoints: readonly Endpoint[], file: string): number[] {
  return [...new Set(endpoints.filter((e) => e.file === file).map((e) => e.line))].sort((a, b) => a - b);
}

/** Menu entries for the endpoints a line declares: one submenu per endpoint when there are several. */
export function endpointMenuItems(endpoints: Endpoint[]): MenuItem[] {
  const items = (e: Endpoint): MenuItem[] => [
    { label: "Generate Request in HTTP Client", icon: "file-http", run: () => void generateRequests([e]) },
    { label: "Show in Endpoints", icon: "toolwindow-endpoints", run: () => showInEndpoints(e) },
  ];
  if (endpoints.length === 1) return items(endpoints[0]!);
  return [
    ...endpoints.map((e) => ({
      label: `${e.method} ${e.path}`,
      verbatim: true,
      icon: e.icon ?? "web",
      submenu: items(e),
    })),
    { kind: "separator" as const },
    {
      label: "Generate Requests for All Endpoints Here",
      icon: "file-http",
      run: () => void generateRequests(endpoints),
    },
  ];
}

/** The endpoints declared at the caret of the active editor. */
export function endpointsAtCaret(): Endpoint[] {
  const e = activeEditor();
  if (!e || e.ctx.virtual) return [];
  const line = e.view.state.doc.lineAt(e.view.state.selection.main.head).number;
  return endpointsAt(useEndpoints.getState().endpoints, e.ctx.path, line);
}

/** Editor context menu items for a file that declares endpoints. */
export function menuGroupItems(ctx: MenuGroupContext): MenuItem[] {
  const path = ctx.paths[0];
  if (!path || ctx.text === undefined || ctx.line === undefined) return [];
  const e = activeEditor();
  if (!e || e.ctx.path !== path) return [];
  const endpoints = endpointsAtCaret();
  if (!endpoints.length) return [];
  if (endpoints.length === 1)
    return [
      { kind: "action", action: GENERATE_REQUEST, icon: "file-http" },
      { kind: "action", action: SHOW_IN_ENDPOINTS, icon: "toolwindow-endpoints" },
    ];
  return [{ label: "Endpoints", icon: "toolwindow-endpoints", submenu: endpointMenuItems(endpoints) }];
}

// --- gutter ----------------------------------------------------------------------

interface Mark {
  /** Offset of the line start. */
  pos: number;
  title: string;
  endpoints: Endpoint[];
}

const setMarks = StateEffect.define<Mark[]>();

const marksField = StateField.define<Mark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    // Unsaved edits move the icons with their lines; the table itself follows the next save.
    return value.map((m) => ({ ...m, pos: tr.state.doc.lineAt(tr.changes.mapPos(m.pos, -1)).from }));
  },
});

/** Marks for `path` from the current endpoints. */
export function computeMarks(state: EditorState, path: string, endpoints: readonly Endpoint[]): Mark[] {
  const doc = state.doc;
  return endpointLines(endpoints, path)
    .filter((line) => line >= 1 && line <= doc.lines)
    .map((line) => {
      const here = endpointsAt(endpoints, path, line);
      const title =
        here.length === 1 ? `${here[0]!.method} ${here[0]!.path} → ${here[0]!.target}` : tx`${here.length} endpoints`;
      return { pos: doc.line(line).from, title, endpoints: here };
    });
}

class EndpointMarker extends GutterMarker {
  constructor(readonly mark: Mark) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof EndpointMarker &&
      other.mark.title === this.mark.title &&
      other.mark.endpoints.length === this.mark.endpoints.length
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    el.title = this.mark.title;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.mark.title);
    el.innerHTML = gutterIconMarkup(this.mark.endpoints[0]?.icon ?? "web") ?? "";
    return el;
  }
}

function sameMarks(a: Mark[], b: Mark[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => m.pos === b[i]!.pos && m.title === b[i]!.title && m.endpoints.length === b[i]!.endpoints.length)
  );
}

export function endpointsEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || isVirtualUri(ctx.path)) return [];
  const path = ctx.path;
  const follower = ViewPlugin.fromClass(
    class {
      unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.unsubscribe = useEndpoints.subscribe((s, prev) => {
          if (s.endpoints !== prev.endpoints) this.refresh();
        });
        // The endpoints may already be there (the editor opened after the project).
        setTimeout(() => this.refresh(), 0);
      }
      refresh() {
        const found = computeMarks(this.view.state, path, useEndpoints.getState().endpoints);
        if (!sameMarks(this.view.state.field(marksField), found)) this.view.dispatch({ effects: setMarks.of(found) });
      }
      destroy() {
        this.unsubscribe();
      }
    },
  );
  const intentions = (view: EditorView): ContributedIntention[] => {
    const marks = view.state.field(marksField, false);
    if (!marks?.length) return [];
    const line = view.state.doc.lineAt(view.state.selection.main.head).from;
    const mark = marks.find((m) => m.pos === line);
    if (!mark) return [];
    return [
      {
        id: GENERATE_REQUEST,
        label: "Generate Request in HTTP Client",
        icon: "file-http",
        run: () => generateRequests(mark.endpoints),
      },
      {
        id: SHOW_IN_ENDPOINTS,
        label: "Show in Endpoints",
        icon: "toolwindow-endpoints",
        run: () => showInEndpoints(mark.endpoints[0]!),
      },
    ];
  };
  return [
    marksField,
    follower,
    intentionProviders.of(intentions),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-endpoints`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(marksField).map((m) => new EndpointMarker(m).range(m.pos)),
          true,
        ),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const mark = view.state.field(marksField).find((m) => m.pos === block.from);
          if (!mark || (event as MouseEvent).button !== 0) return false;
          const el = (event.target as HTMLElement).closest?.(`.${styles.runMarker}`) as HTMLElement | null;
          const rect = (el ?? (event.target as HTMLElement)).getBoundingClientRect();
          event.preventDefault();
          showContextMenu({ x: rect.left, y: rect.bottom + 2 }, endpointMenuItems(mark.endpoints));
          return true;
        },
      },
    }),
  ];
}
