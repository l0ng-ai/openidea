/**
 * Editor integration for `.http` files: a ▶ gutter icon on every request line
 * (like run configurations' gutter) and a toolbar panel above the text with
 * the environment selector, Run All and Stop.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, showPanel, type Panel, type ViewUpdate } from "@codemirror/view";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { shortcutLabel } from "@/platform/keymap";
import { isVirtualUri } from "@/platform/virtualDocs";
import type { HttpRequestBlock } from "@/platform/ipc";
import { IconButton, Select, gutterIconMarkup, T } from "@/ui";
import {
  cancelRunning,
  loadEnvironments,
  parseRequests,
  runAll,
  runRequest,
  setEnvironment,
  useHttpClient,
} from "./store";
import styles from "./HttpClient.module.css";

export const HTTP_LANGUAGE = "http";

interface Placed extends HttpRequestBlock {
  /** Line start offset in the current state. */
  pos: number;
}

const setRequests = StateEffect.define<Placed[]>();

export const requestsField = StateField.define<Placed[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRequests)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.map((r) => {
      const pos = tr.state.doc.lineAt(tr.changes.mapPos(r.pos, -1)).from;
      return { ...r, pos, line: tr.state.doc.lineAt(pos).number - 1 };
    });
  },
});

function place(state: EditorState, blocks: HttpRequestBlock[]): Placed[] {
  return blocks.filter((b) => b.line < state.doc.lines).map((b) => ({ ...b, pos: state.doc.line(b.line + 1).from }));
}

/** The request whose block contains the caret (else the nearest one above it). */
export function requestAtCaret(view: EditorView): Placed | null {
  const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  const all = view.state.field(requestsField, false) ?? [];
  let best: Placed | null = null;
  for (const r of all) {
    if (r.startLine <= line && line <= Math.max(r.endLine, r.line)) return r;
    if (r.line <= line) best = r;
  }
  return best ?? all[0] ?? null;
}

/** Re-parses now (before running from a shortcut right after typing). */
export async function refreshRequests(view: EditorView): Promise<void> {
  const found = place(view.state, await parseRequests(view.state.doc.toString()));
  view.dispatch({ effects: setRequests.of(found) });
}

class RequestMarker extends GutterMarker {
  constructor(readonly request: Placed) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof RequestMarker &&
      other.request.index === this.request.index &&
      other.request.url === this.request.url
    );
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    const label = this.request.name ?? `${this.request.method} ${this.request.url}`;
    el.title = `Run '${label}'`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup("gutter-run") ?? "";
    return el;
  }
}

function markers(state: EditorState): RangeSet<GutterMarker> {
  return RangeSet.of(
    state.field(requestsField).map((r) => new RequestMarker(r).range(r.pos)),
    true,
  );
}

function Toolbar({ path, view }: { path: string | null; view: EditorView }) {
  const envs = useHttpClient((s) => (path ? s.environments[path] : undefined));
  const chosen = useHttpClient((s) => (path ? s.envByFile[path] : undefined));
  const running = useHttpClient((s) => !!s.running && s.running.path === path);
  useEffect(() => {
    if (path) void loadEnvironments(path);
  }, [path]);
  const options = [{ value: "", label: "No Environment" }, ...(envs ?? []).map((e) => ({ value: e, label: e }))];
  return (
    <div className={styles.toolbar}>
      <IconButton
        icon="gutter-run-all"
        title="Run All Requests in File"
        shortcut={shortcutLabel("http.runAll")}
        onClick={() => void runAll(path, view.state.doc.toString())}
      />
      <IconButton icon="stop" title="Stop" disabled={!running} onClick={cancelRunning} />
      <span className={styles.toolbarLabel}>
        <T>Run with:</T>
      </span>
      <Select
        aria-label="Environment"
        value={chosen && envs?.includes(chosen) ? chosen : ""}
        options={options}
        onChange={(v) => path && setEnvironment(path, v || null)}
        disabled={!path}
      />
      <IconButton
        icon="refresh"
        title="Reload Environments"
        disabled={!path}
        onClick={() => path && void loadEnvironments(path)}
      />
    </div>
  );
}

function toolbarPanel(path: string | null) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    root.render(<Toolbar path={path} view={view} />);
    return { dom, top: true, destroy: () => queueMicrotask(() => root.unmount()) };
  };
}

const DEBOUNCE = 300;

export function httpEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== HTTP_LANGUAGE) return [];
  const path = ctx.virtual || isVirtualUri(ctx.path) ? null : ctx.path;
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
          void refreshRequests(this.view).catch(() => {});
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [
    requestsField,
    detector,
    showPanel.of(toolbarPanel(path)),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-http`,
      markers: (view) => markers(view.state),
      initialSpacer: () =>
        new RequestMarker({ index: 0, name: null, method: "", url: "", line: 0, startLine: 0, endLine: 0, pos: 0 }),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          const r = view.state.field(requestsField).find((x) => x.pos === block.from);
          if (!r || (event as MouseEvent).button !== 0) return false;
          event.preventDefault();
          void runRequest(path, view.state.doc.toString(), r.index);
          return true;
        },
      },
    }),
  ];
}
