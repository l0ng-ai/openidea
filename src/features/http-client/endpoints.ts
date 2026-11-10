import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin } from "@codemirror/view";
import { gutter } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { gutterIconMarkup, showContextMenu } from "@/ui";
import { emptyGutterSpacer, gutterSpacer } from "@/editor/api";
import { notifications, onEndpointsChanged, searchEndpoints, type EndpointEntry } from "@/workbench/contributions";
import { appendGeneratedRequests } from "./generatedRequests";
import { METHODS } from "./language";
import styles from "./HttpClient.module.css";

export const OPEN_ENDPOINT = "http.openEndpoint";

export const endpointUrl = (path: string) => path.replace(/\{(?!\{)([\w.-]+)\}(?!\})/g, "{{$1}}");

export function renderEndpoint(e: EndpointEntry): string {
  return `### ${e.handler ?? `${e.method} ${e.url}`}\n${e.method === "*" ? "GET" : e.method} http://localhost:8080${endpointUrl(e.url)}\n`;
}

export async function openEndpoint(endpoint: EndpointEntry): Promise<void> {
  try {
    await appendGeneratedRequests([renderEndpoint(endpoint)]);
  } catch (e) {
    notifications().notify({ level: "error", title: tx("Cannot generate the HTTP request"), body: String(e) });
  }
}

/** Only the URL of the first request line in a request block is completed. */
export function completionTarget(text: string, pos: number): { from: number; method: string; prefix: string } | null {
  const before = text.slice(0, pos);
  const start = before.lastIndexOf("\n") + 1;
  const line = before.slice(start);
  const m = new RegExp(`^\\s*(${METHODS.join("|")})\\s+(\\S*)$`).exec(line);
  if (!m) return null;
  const block =
    before
      .slice(0, start)
      .split(/^\s*###.*$/m)
      .at(-1) ?? "";
  if (block.split("\n").some((l) => new RegExp(`^\\s*(?:${METHODS.join("|")})\\s+|^\\s*https?://`).test(l)))
    return null;
  const url = m[2]!;
  const origin = /^(?:https?:\/\/[^/\s]+|\{\{[^}]+\}\})(?=\/|$)/.exec(url)?.[0] ?? "";
  if (url && !origin && !url.startsWith("/")) return null;
  return { from: pos - url.length + origin.length, method: m[1]!, prefix: url.slice(origin.length) };
}

export async function endpointCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const target = completionTarget(context.state.doc.toString(), context.pos);
  if (!target) return null;
  const root = useProject.getState().project?.root ?? null;
  const endpoints = await searchEndpoints(root);
  if (context.aborted || root !== (useProject.getState().project?.root ?? null)) return null;
  const seen = new Set<string>();
  return {
    from: target.from,
    options: endpoints
      .filter((e) => {
        if ((e.method !== "*" && e.method !== target.method) || !e.url.startsWith(target.prefix) || seen.has(e.url))
          return false;
        seen.add(e.url);
        return true;
      })
      .map((e) => ({ label: endpointUrl(e.url), detail: e.handler ?? e.framework, type: "url" })),
  };
}

type Mark = { pos: number; endpoints: EndpointEntry[] };
const setMarks = StateEffect.define<Mark[]>();
const marks = StateField.define<Mark[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    return tr.docChanged ? [] : value;
  },
});

class EndpointMarker extends GutterMarker {
  override toDOM(): Node {
    const button = document.createElement("button");
    button.type = "button";
    button.className = styles.runMarker ?? "";
    button.title = tx("Open in HTTP Client");
    button.setAttribute("aria-label", button.title);
    button.innerHTML = gutterIconMarkup("file-http") ?? "";
    return button;
  }
}

const endpointSpacer = gutterSpacer(styles.runMarker ?? "");

export function endpointEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.language === "http") return EditorState.languageData.of(() => [{ openideaCompletion: endpointCompletion }]);
  if (ctx.virtual) return [];
  return [
    marks,
    ViewPlugin.fromClass(
      class {
        seq = 0;
        destroyed = false;
        unsubscribe: () => void;
        projectUnsubscribe: () => void;
        constructor(readonly view: EditorView) {
          this.unsubscribe = onEndpointsChanged(() => this.refresh());
          this.projectUnsubscribe = useProject.subscribe(() => this.refresh());
          this.refresh();
        }
        update(u: { docChanged: boolean }) {
          if (u.docChanged) this.refresh();
        }
        refresh() {
          const seq = ++this.seq;
          const root = useProject.getState().project?.root ?? null;
          void searchEndpoints(root).then((entries) => {
            if (this.destroyed || seq !== this.seq) return;
            const byLine = new Map<number, EndpointEntry[]>();
            for (const e of entries) {
              if (!e.pluginId || e.path !== ctx.path || e.line >= this.view.state.doc.lines) continue;
              const pos = this.view.state.doc.line(e.line + 1).from;
              byLine.set(pos, [...(byLine.get(pos) ?? []), e]);
            }
            this.view.dispatch({ effects: setMarks.of([...byLine].map(([pos, endpoints]) => ({ pos, endpoints }))) });
          });
        }
        destroy() {
          this.destroyed = true;
          this.unsubscribe();
          this.projectUnsubscribe();
        }
      },
    ),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-endpoints`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(marks).map((m) => new EndpointMarker().range(m.pos)),
          true,
        ),
      // One icon of width only while the file has endpoints; other files keep a narrow gutter.
      initialSpacer: () => emptyGutterSpacer,
      updateSpacer: (_spacer, update) => (update.state.field(marks).length ? endpointSpacer : emptyGutterSpacer),
      domEventHandlers: {
        mousedown: (view, line, event) => {
          if ((event as MouseEvent).button !== 0) return false;
          const found = view.state.field(marks).find((m) => m.pos === line.from);
          if (!found) return false;
          event.preventDefault();
          const rect = (event.target as HTMLElement).getBoundingClientRect();
          showContextMenu(
            { x: rect.left, y: rect.bottom },
            found.endpoints.map((e) => ({
              label: `${e.method} ${e.url}`,
              verbatim: true,
              icon: "file-http",
              run: () => {
                void executeAction(OPEN_ENDPOINT, e);
              },
            })),
          );
          return true;
        },
      },
    }),
  ];
}
