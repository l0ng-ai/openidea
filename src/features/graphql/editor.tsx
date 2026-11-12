/**
 * GraphQL in editors, after IDEA's GraphQL plugin (JetBrains/js-graphql-intellij-plugin):
 * - the toolbar above GraphQL files: Open Configuration File, Edit Environment Variables,
 *   Toggle Variables Editor, the endpoint, Execute GraphQL, Rerun Introspection Query and
 *   Open Introspection Schema; the variables editor (JSON) shows below it;
 * - schema files re-checked as they are edited (unresolved types);
 * - in graphql-config files, ▶ on each endpoint runs its introspection query.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  showPanel,
  type DecorationSet,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { EditorDocContext } from "@/editor/api";
import { highlightInto } from "@/editor/lsp/markdown";
import { useTx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { basename } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { IconButton, Select, gutterIconMarkup } from "@/ui";
import { endpointLines, isConfigFile, outsideRanges, queryContext } from "./model";
import {
  chooseEndpoint,
  configurationFor,
  discoverSchemasNow,
  editEnvironmentVariables,
  endpointFor,
  introspectEndpoint,
  openConfiguration,
  openIntrospectionSchema,
  rerunIntrospection,
  revalidateFile,
  runQuery,
  schemaOf,
  setVariables,
  toggleVariables,
  useGraphQL,
} from "./store";
import styles from "./GraphQL.module.css";

export const GRAPHQL_LANGUAGE = "graphql";

// --- query context: what Execute GraphQL sent, the rest greyed out (IDEA) ---------------------

const setSentRanges = StateEffect.define<Array<{ from: number; to: number }>>();
const unusedMark = Decoration.mark({ class: styles.unusedContext ?? "" });

/** Greys out the text the last Execute GraphQL left out, until the text or selection changes. */
const unusedContext = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setSentRanges))
        return Decoration.set(
          outsideRanges(tr.state.doc.length, e.value)
            .filter((r) => r.to > r.from)
            .map((r) => unusedMark.range(r.from, r.to)),
        );
    return tr.docChanged || tr.selection ? Decoration.none : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Execute GraphQL in `view`: the selection, else the operation at the caret (with its fragments). */
export function runFromView(path: string, view: EditorView): Promise<void> {
  const { state } = view;
  const { from, to } = state.selection.main;
  const context = queryContext(state.doc.toString(), { from, to });
  if (view.state.field(unusedContext, false) !== undefined)
    view.dispatch({ effects: setSentRanges.of(context.ranges) });
  return runQuery(path, context.text);
}

function Toolbar({ path, view }: { path: string; view: EditorView }) {
  const tx = useTx();
  const projects = useGraphQL((s) => s.projects);
  const discovering = useGraphQL((s) => s.discovering);
  const running = useGraphQL((s) => s.running !== null);
  const endpoint = useGraphQL((s) => endpointFor(s, path));
  const variablesShown = useGraphQL((s) => s.variablesShown.has(path));
  useEffect(() => {
    if (!projects && !discovering) void discoverSchemasNow();
  }, [projects, discovering]);

  const config = configurationFor(projects, path);
  const schema = projects ? schemaOf(projects, path) : null;
  const endpoints = schema?.endpoints ?? [];
  return (
    <div className={styles.editorToolbar} role="toolbar" aria-label={tx("GraphQL editor actions")}>
      <IconButton
        icon="settings"
        title="Open Configuration File"
        disabled={!config}
        onClick={() => void openConfiguration(path)}
      />
      <IconButton
        icon="sliders"
        title="Edit Environment Variables"
        disabled={!schema?.variables.length}
        onClick={() => void editEnvironmentVariables(path)}
      />
      <span className={styles.editorToolbarSep} />
      <IconButton
        icon="graphql-variables"
        title="Toggle Variables Editor"
        pressed={variablesShown}
        onClick={() => toggleVariables(path)}
      />
      <Select
        aria-label="GraphQL endpoint"
        className={styles.endpoint}
        value={endpoint?.name ?? null}
        placeholder={tx("No endpoints")}
        disabled={!endpoints.length}
        options={endpoints.map((e) => ({ value: e.name, label: `${e.name} - ${e.url}` }))}
        onChange={(name) => chooseEndpoint(path, name)}
      />
      <IconButton
        icon="run"
        title="Execute GraphQL"
        shortcut={shortcutLabel("graphql.runQuery")}
        disabled={!endpoint || running}
        onClick={() => void runFromView(path, view)}
      />
      <IconButton
        icon="refresh"
        title="Rerun Introspection Query"
        disabled={!endpoint || running}
        onClick={() => void rerunIntrospection(path)}
      />
      <IconButton
        icon="external-link"
        title="Open Introspection Schema"
        disabled={!schema}
        onClick={() => void openIntrospectionSchema(path)}
      />
    </div>
  );
}

/** The variables editor: JSON in the editor's colours (a highlighted layer under a transparent textarea). */
function VariablesEditor({ path }: { path: string }) {
  const tx = useTx();
  const shown = useGraphQL((s) => s.variablesShown.has(path));
  const text = useGraphQL((s) => s.variables[path] ?? "");
  const layer = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    // A trailing newline keeps the layer as tall as the textarea's last (empty) line.
    const shownText = `${text}\n`;
    el.textContent = shownText;
    if (text) void highlightInto(el, shownText, "JSON");
  }, [text, shown]);
  if (!shown) return null;
  return (
    <div className={styles.variablesBox}>
      <pre ref={layer} className={styles.variablesLayer} aria-hidden />
      <textarea
        className={styles.variables}
        aria-label={tx("GraphQL variables")}
        placeholder='{ "code": "VN" }'
        spellCheck={false}
        value={text}
        onChange={(e) => setVariables(path, e.target.value)}
        onScroll={(e) => {
          const el = layer.current;
          if (!el) return;
          el.scrollTop = e.currentTarget.scrollTop;
          el.scrollLeft = e.currentTarget.scrollLeft;
        }}
      />
    </div>
  );
}

function headerPanel(path: string) {
  return (view: EditorView): Panel => {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    root.render(
      <>
        <Toolbar path={path} view={view} />
        <VariablesEditor path={path} />
      </>,
    );
    return { dom, top: true, destroy: () => queueMicrotask(() => root.unmount()) };
  };
}

const REVALIDATE_DELAY = 300;

/** Re-checks the schema from the editor's text as it is edited. */
function revalidation(path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {}
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => revalidateFile(path, this.view.state.doc.toString()), REVALIDATE_DELAY);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
}

// --- graphql-config: ▶ on each endpoint (Get GraphQL Schema from Endpoint) -------------------

class EndpointMarker extends GutterMarker {
  constructor(readonly endpoint: string) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof EndpointMarker && other.endpoint === this.endpoint;
  }
  override toDOM(): Node {
    const el = document.createElement("div");
    el.className = styles.runMarker ?? "";
    el.title = "Run Introspection Query";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", el.title);
    el.innerHTML = gutterIconMarkup("gutter-run") ?? "";
    return el;
  }
}

function endpointMarkers(name: string) {
  const compute = (state: EditorState) =>
    RangeSet.of(
      endpointLines(name, state.doc.toString())
        .filter((e) => e.line < state.doc.lines)
        .map((e) => new EndpointMarker(e.endpoint).range(state.doc.line(e.line + 1).from)),
      true,
    );
  return StateField.define<RangeSet<GutterMarker>>({
    create: compute,
    update: (value, tr) => (tr.docChanged ? compute(tr.state) : value),
  });
}

function configExtension(path: string): Extension {
  const field = endpointMarkers(basename(path));
  return [
    field,
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-graphql`,
      markers: (view) => view.state.field(field),
      initialSpacer: () => new EndpointMarker(""),
      domEventHandlers: {
        mousedown: (view, block, event) => {
          if ((event as MouseEvent).button !== 0) return false;
          let endpoint: string | null = null;
          view.state.field(field).between(block.from, block.from, (_from, _to, m) => {
            endpoint = (m as EndpointMarker).endpoint;
          });
          if (endpoint === null) return false;
          event.preventDefault();
          void introspectEndpoint(path, endpoint);
          return true;
        },
      },
    }),
  ];
}

export function graphqlEditorExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || isVirtualUri(ctx.path)) return [];
  if (isConfigFile(basename(ctx.path))) return configExtension(ctx.path);
  if (ctx.language !== GRAPHQL_LANGUAGE) return [];
  return [showPanel.of(headerPanel(ctx.path)), revalidation(ctx.path), unusedContext];
}
