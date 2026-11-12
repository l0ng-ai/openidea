import { StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  hoverTooltip,
  type DecorationSet as CmDecorations,
  type Tooltip,
} from "@codemirror/view";
import type { DecorationSet, Range } from "@/bindings";
import { registerEditorContribution, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { hoverCard } from "@/editor/lsp/hover";
import { highlightInto, loadMarkdown, markupToHtml, renderMarkup } from "@/editor/lsp/markdown";
import { commands, isTauri } from "@/platform/ipc";
import { logError } from "@/platform/errorLog";
import { useProject } from "@/platform/project";
import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import styles from "./decorations.module.css";

const snapshots = new Map<string, DecorationSet[]>();
const refresh = StateEffect.define<null>();
const versions = new Map<string, number>();
const colors: Record<string, string> = {
  highlight: "var(--accent)",
  search: "var(--fg-search-match)",
  added: "var(--vcs-added)",
  modified: "var(--vcs-modified)",
  removed: "var(--vcs-deleted)",
  warning: "var(--warning)",
  error: "var(--danger)",
  info: "var(--info)",
  underline: "var(--fg-editor)",
  strikethrough: "var(--fg-editor)",
  muted: "var(--fg-muted)",
};

function currentSets(sets: DecorationSet[]) {
  const root = useProject.getState().project?.root;
  return sets.filter((s) => s.root === root);
}

function updateTree(plugin: string, sets: DecorationSet[]) {
  const items = new Map<string, FileDecoration>();
  for (const s of currentSets(sets))
    if (s.tree && s.file && Object.hasOwn(colors, s.file.style)) {
      items.set(s.path, {
        color: colors[s.file.style],
        badge: s.file.badge ?? undefined,
        tooltip: s.file.tooltip ?? undefined,
        faded: s.file.style === "muted",
        error: s.file.style === "error",
      });
    }
  setFileDecorations(`plugin:${plugin}`, items);
}

/** Replace a plugin's snapshots. Project roots are filtered on every render. */
export function setPluginDecorations(plugin: string, sets: DecorationSet[]) {
  versions.set(plugin, (versions.get(plugin) ?? 0) + 1);
  snapshots.set(plugin, sets);
  updateTree(plugin, sets);
  refreshOpenHovers(plugin);
  for (const editor of useEditorRegistry.getState().editors) editor.view.dispatch({ effects: refresh.of(null) });
}

function offset(doc: Text, pos: Range["start"]): number | null {
  if (pos.line >= doc.lines) return null;
  const line = doc.line(pos.line + 1);
  return pos.col <= line.length ? line.from + pos.col : null;
}

class AfterText extends WidgetType {
  constructor(
    readonly text: string,
    readonly style: string,
    readonly hover: string | null,
    readonly markdown: string | null,
  ) {
    super();
  }
  override eq(other: AfterText) {
    return (
      this.text === other.text &&
      this.style === other.style &&
      this.hover === other.hover &&
      this.markdown === other.markdown
    );
  }
  override toDOM() {
    const span = document.createElement("span");
    span.className = `${styles.after} ${this.style}`;
    span.textContent = this.text;
    // The Markdown hover card replaces the native tooltip; two would stack.
    if (this.hover && !this.markdown) span.title = this.hover;
    return span;
  }
}

/** A Markdown hover placed on a range (and its `after` label). */
interface PlacedHover {
  plugin: string;
  path: string;
  range: Range;
  from: number;
  to: number;
  after: boolean;
  markdown: string;
}

/** A hover card that is open now; refreshed when its plugin pushes new data. */
interface OpenHover {
  plugin: string;
  path: string;
  range: Range;
  dom: HTMLElement;
  uiMode: EditorDocContext["uiMode"];
}

const openHovers = new Set<OpenHover>();

function sameRange(a: Range, b: Range) {
  return (
    a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col
  );
}

/** The conversation a plugin now has for an open card, if it is still there. */
function refreshedMarkdown(card: OpenHover) {
  for (const set of currentSets(snapshots.get(card.plugin) ?? []))
    if (!set.tree && set.path === card.path)
      for (const item of set.items)
        if (item.markdownHover && sameRange(item.range, card.range)) return item.markdownHover;
  return null;
}

/** Plugin Markdown has no authority to load resources from the workbench. */
function withoutPluginResources(html: string): string {
  // Template contents are inert: strip resources before they enter the rendered DOM.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll("img, picture, audio, video, source, track"))
    element.remove();
  for (const element of template.content.querySelectorAll("[src], [srcset], [poster], [background]")) {
    for (const attribute of ["src", "srcset", "poster", "background"]) element.removeAttribute(attribute);
  }
  return template.innerHTML;
}

/** Keep the shared renderer's links/styles without its unfiltered async Markdown rewrite. */
function renderPluginMarkdown(value: string, language: string | null): HTMLElement {
  const dom = renderMarkup({ kind: "plaintext", value: "" }, language);
  let rendered: string | undefined;
  const update = () => {
    const html = withoutPluginResources(markupToHtml({ kind: "markdown", value }));
    if (html === rendered) return;
    rendered = html;
    dom.innerHTML = html;
    for (const code of dom.querySelectorAll<HTMLElement>("pre > code")) {
      const declared = [...code.classList].find((name) => name.startsWith("language-"));
      const text = (code.textContent ?? "").replace(/\n+$/, "");
      code.textContent = text;
      void highlightInto(code, text, declared?.slice("language-".length) ?? language);
    }
  };
  update();
  void loadMarkdown()
    .then(update)
    .catch((error: unknown) => logError("cannot render plugin Markdown", error));
  return dom;
}

/** Replace the content of cards whose labels were published again. */
function refreshOpenHovers(plugin: string) {
  for (const card of openHovers) {
    if (card.plugin !== plugin) continue;
    const markdown = refreshedMarkdown(card);
    if (markdown) card.dom.replaceChildren(renderPluginMarkdown(markdown, card.uiMode));
  }
}

interface PlacedDecorations {
  decorations: CmDecorations;
  hovers: PlacedHover[];
}

export function decorationExtension(ctx: EditorDocContext) {
  const field = StateField.define<PlacedDecorations>({
    create: (state) => build(state.doc),
    update: (value, tr) => {
      if (tr.effects.some((e) => e.is(refresh))) return build(tr.state.doc);
      if (tr.docChanged)
        return {
          decorations: value.decorations.map(tr.changes),
          // Follow the same positions as the rendered labels: the mark starts
          // after an insertion at its edge, and an after label tracks its text.
          hovers: value.hovers.map((h) => ({
            ...h,
            from: tr.changes.mapPos(h.from, 1),
            to: tr.changes.mapPos(h.to, h.after ? 1 : -1),
          })),
        };
      // A caret move or a selection change must not drop the hover data.
      return value;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  const build = (doc: Text): PlacedDecorations => {
    const ranges = [];
    const hovers: PlacedHover[] = [];
    for (const [plugin, sets] of snapshots)
      for (const set of currentSets(sets))
        if (!set.tree && set.path === ctx.path) {
          for (const item of set.items) {
            const className = Object.hasOwn(colors, item.style) ? styles[item.style] : undefined;
            if (!className) continue;
            const from = offset(doc, item.range.start),
              to = offset(doc, item.range.end);
            if (from == null || to == null || from > to) continue;
            const markdown = item.markdownHover || null;
            if (markdown)
              hovers.push({ plugin, path: ctx.path, range: item.range, from, to, after: !!item.after, markdown });
            if (from < to)
              ranges.push(
                Decoration.mark({
                  class: className,
                  attributes: item.hover && !markdown ? { title: item.hover } : {},
                }).range(from, to),
              );
            if (item.after)
              ranges.push(
                Decoration.widget({
                  widget: new AfterText(item.after, className, item.hover, markdown),
                  side: 1,
                }).range(to),
              );
          }
        }
    return { decorations: Decoration.set(ranges, true), hovers };
  };

  return [field, hoverTooltip(markdownHover(field, ctx), { hideOnChange: true })];
}

/**
 * The decoration under the pointer, preferring an `after` label when the
 * pointer is on its widget rather than on the decorated text.
 */
function markdownHover(field: StateField<PlacedDecorations>, ctx: EditorDocContext) {
  return (view: EditorView, pos: number, side: number): Tooltip | null => {
    const hovers = view.state.field(field).hovers;
    const candidates = hovers.filter((h) => h.from <= pos && pos <= h.to);
    const placed = candidates.find((h) => h.after && h.to === pos && side >= 0) ?? candidates[candidates.length - 1];
    if (!placed) return null;
    return {
      pos: placed.from,
      end: placed.to,
      above: true,
      create: () => {
        const dom = hoverCard([renderPluginMarkdown(placed.markdown, ctx.uiMode)]);
        const card: OpenHover = {
          plugin: placed.plugin,
          path: placed.path,
          range: placed.range,
          dom,
          uiMode: ctx.uiMode,
        };
        openHovers.add(card);
        return { dom, destroy: () => openHovers.delete(card) };
      },
    };
  };
}

/** Catch up editors and project trees opened after publication. */
export function startPluginDecorations(): () => void {
  let disposed = false;
  let revision = 0;
  const load = () => {
    const at = ++revision;
    const before = new Map(versions);
    if (isTauri())
      void Promise.resolve(commands.pluginDecorationSets())
        .then((all) => {
          if (disposed || at !== revision) return;
          for (const plugin of snapshots.keys())
            if (!all[plugin] && versions.get(plugin) === before.get(plugin)) setPluginDecorations(plugin, []);
          for (const [plugin, sets] of Object.entries(all))
            if (versions.get(plugin) === before.get(plugin)) setPluginDecorations(plugin, sets);
        })
        .catch(() => {});
  };
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root === prev.project?.root) return;
    for (const [plugin, sets] of snapshots) updateTree(plugin, sets);
    for (const editor of useEditorRegistry.getState().editors) editor.view.dispatch({ effects: refresh.of(null) });
    load();
  });
  const off = registerEditorContribution({
    id: "plugins.decorations",
    extensions: decorationExtension,
  });
  load();
  return () => {
    disposed = true;
    offProject();
    off();
    for (const plugin of snapshots.keys()) setPluginDecorations(plugin, []);
    snapshots.clear();
    versions.clear();
  };
}
