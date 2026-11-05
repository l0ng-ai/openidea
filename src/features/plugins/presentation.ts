/** Declarative plugin gutters and embedded-language regions, rendered from cached indexes. */
import { Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { LanguageDescription, highlightingFor } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree, tags } from "@lezer/highlight";
import { registerEditorContribution } from "@/editor/api";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { usePluginPresentations, watchPluginPresentation } from "@/platform/pluginPresentation";
import { editorPrefs } from "@/platform/editorSettings";
import { useProject } from "@/platform/project";
import { useFileIconRevision } from "@/ui/icons";
import { navigationButton } from "./navigationButton";
import type { FilePresentation, Location, EmbeddedRegion } from "@/platform/ipc";

class MappingMarker extends GutterMarker {
  constructor(
    readonly targets: Location[],
    readonly icon: string,
  ) {
    super();
  }
  override toDOM() {
    return navigationButton(this.targets, this.icon);
  }
}
const setPresentation = StateEffect.define<{ markers: RangeSet<GutterMarker>; decorations: DecorationSet }>();
const field = StateField.define({
  create: () => ({ markers: RangeSet.empty as RangeSet<GutterMarker>, decorations: Decoration.none }),
  update(value, tr) {
    if (tr.docChanged) value = { markers: RangeSet.empty, decorations: Decoration.none };
    for (const effect of tr.effects) if (effect.is(setPresentation)) value = effect.value;
    return value;
  },
  provide: (f) => Prec.highest(EditorView.decorations.from(f, (v) => v.decorations)),
});

export function embeddedOffsets(doc: Text, regions: EmbeddedRegion[]) {
  const sorted = regions
    .filter((r) => r.language === "sql")
    .map((r) => rangeToOffsets(doc, r.range))
    .filter((r) => r.from < r.to)
    .sort((a, b) => a.from - b.from);
  const result: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = result.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else result.push({ ...r });
  }
  return result;
}
/** Keep UTF-16 positions while hiding markup and SQL template expressions from the SQL parser. */
export function sqlInput(text: string, regions: readonly { from: number; to: number }[]) {
  const blank = (s: string) => s.replace(/[^\r\n]/g, " ");
  const pieces: string[] = [];
  let at = 0;
  for (const r of regions) {
    pieces.push(blank(text.slice(at, r.from)));
    pieces.push(
      text
        .slice(r.from, r.to)
        .replace(/[#$]\{[^}]*\}/g, blank)
        .replace(
          /&(lt|gt|amp);/g,
          (s, name) => ({ lt: "<", gt: ">", amp: "&" })[name as string]! + " ".repeat(s.length - 1),
        ),
    );
    at = r.to;
  }
  pieces.push(blank(text.slice(at)));
  return pieces.join("");
}
async function sqlDecorations(
  view: EditorView,
  regions: EmbeddedRegion[],
  wanted: () => boolean,
): Promise<DecorationSet> {
  const doc = view.state.doc;
  // Huge documents retain navigation but skip extra highlighting work.
  if (doc.length > 2_000_000) return Decoration.none;
  const ranges = embeddedOffsets(doc, regions);
  if (!ranges.length) return Decoration.none;
  const language = LanguageDescription.matchLanguageName(languages, "SQL");
  if (!language) return Decoration.none;
  const support = language.support ?? (await language.load());
  if (!wanted()) return Decoration.none;
  const text = doc.toString();
  const parse = support.language.parser.startParse(sqlInput(text, ranges));
  let tree;
  while (!tree) {
    if (!wanted()) return Decoration.none;
    const until = performance.now() + 8;
    while (performance.now() < until && !tree) tree = parse.advance();
    if (!tree) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const marks = ranges.map((r) => Decoration.mark({ class: "cm-plugin-sql-region" }).range(r.from, r.to));
  // Full-width injected-language background, with XML islands cut out.
  const lines = new Set<number>();
  for (const r of ranges) {
    for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) {
      const line = doc.line(n);
      if (Math.max(r.from, line.from) < Math.min(r.to, line.to)) lines.add(line.from);
    }
  }
  let region = 0;
  let painted = 0;
  for (const from of lines) {
    if (++painted % 512 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!wanted()) return Decoration.none;
    }
    const line = doc.lineAt(from);
    marks.push(Decoration.line({ class: "cm-plugin-sql-line" }).range(from));
    while (region < ranges.length && ranges[region]!.to <= from) region++;
    let end = from;
    for (let i = region; i < ranges.length && ranges[i]!.from < line.to; i++) {
      const r = ranges[i]!;
      if (end < r.from)
        marks.push(Decoration.mark({ class: "cm-plugin-sql-xml" }).range(end, Math.min(r.from, line.to)));
      end = Math.max(end, Math.min(r.to, line.to));
    }
    if (end < line.to) marks.push(Decoration.mark({ class: "cm-plugin-sql-xml" }).range(end, line.to));
  }
  let cursor = 0;
  highlightTree(tree, { style: (tag) => highlightingFor(view.state, tag) }, (from, to, cls) => {
    while (cursor < ranges.length && ranges[cursor]!.to <= from) cursor++;
    for (let i = cursor; i < ranges.length && ranges[i]!.from < to; i++) {
      const a = Math.max(from, ranges[i]!.from),
        b = Math.min(to, ranges[i]!.to);
      if (a < b) marks.push(Decoration.mark({ class: cls }).range(a, b));
    }
  });
  const parameterClass = highlightingFor(view.state, [tags.special(tags.variableName)]);
  if (parameterClass)
    for (const r of ranges) {
      for (const match of text.slice(r.from, r.to).matchAll(/[#$]\{[^}]*\}/g))
        marks.push(
          Decoration.mark({ class: parameterClass }).range(
            r.from + match.index,
            r.from + match.index + match[0].length,
          ),
        );
    }
  return Decoration.set(marks, true);
}
export function editorPresentation(path: string): Extension {
  return [
    field,
    gutter({ class: "cm-plugin-mapping-gutter", markers: (v) => v.state.field(field).markers }),
    EditorView.baseTheme({
      ".cm-plugin-mapping-button": {
        border: "none",
        padding: "0 2px",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        height: "100%",
        display: "flex",
        alignItems: "center",
      },
      ".cm-plugin-mapping-button svg": { width: "16px", height: "16px" },
      ".cm-plugin-mapping-button:focus-visible": { outline: "1px solid var(--accent)" },
      ".cm-plugin-sql-xml": { backgroundColor: "var(--bg-editor)" },
      ".cm-plugin-sql-line": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
    }),
    ViewPlugin.fromClass(
      class {
        disposed = false;
        revision = 0;
        queued = false;
        last: FilePresentation | undefined;
        parsedDoc: Text | undefined;
        parsedRegions = "";
        parsed = Decoration.none;
        off: () => void;
        unwatch: () => void;
        prefs: () => void;
        icons: () => void;
        constructor(readonly view: EditorView) {
          this.icons = useFileIconRevision.subscribe(() => {
            this.parsedDoc = undefined;
            this.last = undefined;
            this.schedule();
          });
          this.off = usePluginPresentations.subscribe(() => this.schedule());
          this.unwatch = watchPluginPresentation(path);
          this.prefs = useProject.subscribe((s, prev) => {
            if (s.settings !== prev.settings) {
              this.last = undefined;
              this.schedule();
            }
          });
          this.schedule();
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            this.revision++;
            this.last = undefined;
            this.parsedDoc = undefined;
          }
        }
        schedule() {
          if (this.queued || this.disposed) return;
          this.queued = true;
          queueMicrotask(() => {
            this.queued = false;
            if (!this.disposed) void this.refresh();
          });
        }
        async refresh() {
          const entry = usePluginPresentations.getState().entries.get(path);
          if (entry === this.last && entry) return;
          this.last = entry;
          const at = ++this.revision,
            text = this.view.state.doc;
          const wanted = () => !this.disposed && at === this.revision && this.view.state.doc === text;
          const rows = new Map<number, Location[]>();
          if (editorPrefs().showGutterIcons)
            for (const m of entry?.markers ?? []) {
              const pos = rangeToOffsets(text, m.range).from;
              const line = text.lineAt(pos).from;
              const targets = rows.get(line) ?? [];
              for (const target of m.targets)
                if (
                  !targets.some(
                    (t) => t.path === target.path && JSON.stringify(t.range) === JSON.stringify(target.range),
                  )
                )
                  targets.push(target);
              rows.set(line, targets);
            }
          const markers = RangeSet.of(
            [...rows].map(([pos, targets]) => new MappingMarker(targets, entry?.icon ?? "arrow-right").range(pos)),
            true,
          );
          this.view.dispatch({
            effects: setPresentation.of({
              markers,
              decorations: this.parsedDoc === text ? this.parsed : Decoration.none,
            }),
          });
          if (!entry) {
            this.view.dispatch({ effects: setPresentation.of({ markers, decorations: Decoration.none }) });
            return;
          }
          const key = JSON.stringify(entry.regions);
          if (this.parsedDoc !== text || key !== this.parsedRegions) {
            const decorations = await sqlDecorations(this.view, entry.regions, wanted);
            if (!wanted()) return;
            this.parsedDoc = text;
            this.parsedRegions = key;
            this.parsed = decorations;
          }
          if (wanted()) this.view.dispatch({ effects: setPresentation.of({ markers, decorations: this.parsed }) });
        }
        destroy() {
          this.disposed = true;
          this.revision++;
          this.off();
          this.unwatch();
          this.prefs();
          this.icons();
        }
      },
    ),
  ];
}
export function startPluginPresentation() {
  return registerEditorContribution({
    id: "plugins.presentation",
    order: 65,
    extensions: (ctx) => (ctx.virtual || ctx.doc < 0 ? [] : editorPresentation(ctx.path)),
  });
}
