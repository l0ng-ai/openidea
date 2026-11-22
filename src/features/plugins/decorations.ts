import { StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  hoverTooltip,
  closeHoverTooltip,
  activateHover,
  type DecorationSet as CmDecorations,
  type Tooltip,
} from "@codemirror/view";
import type { DecorationSet, Range } from "@/bindings";
import { registerEditorContribution, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { resizableDecorationHover } from "./decorationHover";
import { registerAction } from "@/platform/actions";
import { openDecorationFileAction, prepareDecorationFileLinks } from "./decorationFileLinks";
import type { DocLinkHandler } from "@/editor/lsp/markdown";
import { highlightInto, loadMarkdown, markupToHtml, renderMarkup } from "@/editor/lsp/markdown";
import { foldChipWidth } from "@/editor/core/cm/folding";
import { commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { logError } from "@/platform/errorLog";
import { useRemote } from "@/platform/remote";
import { useProject } from "@/platform/project";
import { addPathIconProvider, bumpFileIconRevision } from "@/ui";
import { notifications, setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import styles from "./decorations.module.css";

const snapshots = new Map<string, DecorationSet[]>();
const pluginIcons = new Map<string, Map<string, string>>();
let removePathIcons: (() => void) | null = null;
const refresh = StateEffect.define<null>();
const versions = new Map<string, number>();
let revision = 0;
let refreshing = false;

function resolvePluginPathIcon(path: string): string | null {
  for (const map of pluginIcons.values()) {
    const icon = map.get(path);
    if (icon) return icon;
  }
  return null;
}

function syncPathIconProvider(changed: boolean) {
  let hasAny = false;
  for (const map of pluginIcons.values()) {
    if (map.size > 0) {
      hasAny = true;
      break;
    }
  }
  if (hasAny && !removePathIcons) {
    removePathIcons = addPathIconProvider(resolvePluginPathIcon);
  } else if (!hasAny && removePathIcons) {
    const dispose = removePathIcons;
    removePathIcons = null;
    dispose();
  } else if (changed) {
    bumpFileIconRevision();
  }
}
const colors: Record<string, string> = {
  highlight: "var(--accent)",
  search: "var(--fg-search-match)",
  added: "var(--vcs-added)",
  modified: "var(--vcs-modified)",
  removed: "var(--vcs-deleted)",
  warning: "var(--warning)",
  error: "var(--danger)",
  info: "var(--info)",
  typo: "var(--wave-typo)",
  weak: "var(--fg-weak-warning)",
  underline: "var(--fg-editor)",
  strikethrough: "var(--fg-editor)",
  muted: "var(--fg-muted)",
};

function currentSets(sets: DecorationSet[], tree: boolean) {
  // Editor annotations follow the file, so a set applies wherever its file is open —
  // including a file outside this window's project. Tree decorations are per root.
  if (!tree) return sets;
  const root = useProject.getState().project?.root;
  return sets.filter((s) => s.root === root);
}

function mapsEqual(a: Map<string, string> | undefined, b: Map<string, string>): boolean {
  if (!a) return b.size === 0;
  if (a.size !== b.size) return false;
  for (const [k, v] of b) if (a.get(k) !== v) return false;
  return true;
}

function updateTree(plugin: string, sets: DecorationSet[]) {
  const items = new Map<string, FileDecoration>();
  const icons = new Map<string, string>();
  for (const s of currentSets(sets, true)) {
    if (!s.tree || !s.file) continue;
    const path = String(s.path).replace(/\\/g, "/");
    if (s.file.icon) {
      icons.set(path, `ext:fileIcon/${plugin}/${s.file.icon}`);
    }
    if (Object.hasOwn(colors, s.file.style) || s.file.note || (s.file.icon && s.file.tooltip)) {
      items.set(s.path, {
        color: Object.hasOwn(colors, s.file.style) ? colors[s.file.style] : undefined,
        badge: s.file.badge ?? undefined,
        tooltip: s.file.tooltip ?? undefined,
        faded: s.file.style === "muted",
        error: s.file.style === "error",
        // A note: muted text after the name, like the VCS branch of a root.
        suffix: s.file.note ? [{ text: s.file.note }] : undefined,
      });
    }
  }
  const prevIcons = pluginIcons.get(plugin);
  const iconsChanged = !mapsEqual(prevIcons, icons);
  if (icons.size > 0) pluginIcons.set(plugin, icons);
  else pluginIcons.delete(plugin);
  syncPathIconProvider(iconsChanged);
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

/** An element's own custom property in px (its anchor offset), or 0. */
function offsetOf(el: HTMLElement, property: string): number {
  return Number.parseFloat(getComputedStyle(el).getPropertyValue(property)) || 0;
}

class AfterText extends WidgetType {
  /** Last offset applied, so the observer does not rewrite the style on every keystroke. */
  private appliedWidth = -1;
  private observer: MutationObserver | undefined;

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
  /**
   * Line-end annotations stack left to right: the code-vision git hint, every plugin message on
   * the line, then the inline blame. Each message steps past the hint and its predecessors on the
   * inner box's offset, not the anchor's margin: a margin would shift the in-flow siblings (the
   * blame) too, and the blame would count them a second time. Neighbours can appear (or go away)
   * after this widget mounted, hence the observer below.
   */
  private stepPastLineEnd(el: HTMLElement) {
    const line = el.closest(".cm-line");
    const inner = el.firstElementChild as HTMLElement | null;
    if (!line || !inner) return;
    const own = offsetOf(el, "--openidea-message-offset");
    const hint = line.querySelector<HTMLElement>(".cm-openidea-lensInlineInner");
    // A folded chip drawn after this anchor paints under the box; step past it first (folding.ts).
    let width = foldChipWidth(el);
    // The hint's inner box sits `--openidea-hint-offset` past its zero-width anchor.
    if (hint) width += Math.round(hint.getBoundingClientRect().width) + offsetOf(hint, "--openidea-hint-offset");
    // Every message before this one adds its own width and offset.
    for (const other of line.querySelectorAll<HTMLElement>(".cm-plugin-after")) {
      if (other === el || other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) continue;
      const box = other.firstElementChild;
      if (box) width += Math.round(box.getBoundingClientRect().width) + offsetOf(other, "--openidea-message-offset");
    }
    if (width === this.appliedWidth) return;
    this.appliedWidth = width;
    // The stylesheet parks the message `own` past the anchor; shift it past the chain too.
    if (width) inner.style.left = `${width + own}px`;
    else inner.style.removeProperty("left");
  }
  override toDOM() {
    // A zero-width anchor with the message in an absolutely positioned inner box, the way the
    // code-vision hint is drawn: the annotation takes no part in the line's flow, so it neither
    // stretches the line nor moves the caret at the line end.
    const span = document.createElement("span");
    span.className = styles.after ?? "";
    // A stable hook for the inline blame, which steps past this message (inlineBlame.ts).
    span.classList.add("cm-plugin-after");
    const text = document.createElement("span");
    text.className = `${styles.afterInner ?? ""} ${this.style}`;
    text.textContent = this.text;
    // The Markdown hover card replaces the native tooltip; two would stack.
    if (this.hover && !this.markdown) text.title = this.hover;
    span.appendChild(text);
    // The element is only measurable once CodeMirror has inserted it: defer to the next task, not a
    // nested frame, so a widget that goes away first simply skips.
    setTimeout(() => {
      if (!span.isConnected) return;
      this.stepPastLineEnd(span);
      const line = span.closest(".cm-line");
      if (!line) return;
      this.observer = new MutationObserver(() => this.stepPastLineEnd(span));
      this.observer.observe(line, { childList: true, subtree: true, characterData: true });
    }, 0);
    return span;
  }
  override destroy() {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

/** A Markdown hover placed on a range (and its `after` label). */
interface PlacedHover {
  doc: Text;
  plugin: string;
  path: string;
  range: Range;
  from: number;
  to: number;
  after: string | null;
  markdown: string;
}

/** A hover card that is open now; refreshed when its plugin pushes new data. */
interface OpenHover {
  invalidate: () => void;
  plugin: string;
  path: string;
  range: Range;
  after: string | null;
  close: () => void;
  dom: HTMLElement;
  render: (markdown: string) => HTMLElement;
}

const openHovers = new Set<OpenHover>();

function sameRange(a: Range, b: Range) {
  return (
    a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col
  );
}

/** The conversation a plugin now has for an open card, if it is still there. */
function refreshedMarkdown(card: OpenHover) {
  for (const set of currentSets(snapshots.get(card.plugin) ?? [], false))
    if (!set.tree && set.path === card.path)
      for (const item of set.items)
        if (
          item.markdownHover &&
          Object.hasOwn(colors, item.style) &&
          item.after === card.after &&
          sameRange(item.range, card.range)
        )
          return item.markdownHover;
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
function renderPluginMarkdown(value: string, language: string | null, onLink: DocLinkHandler): HTMLElement {
  const dom = renderMarkup({ kind: "plaintext", value: "" }, language, onLink);
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
    card.invalidate();
    const markdown = refreshedMarkdown(card);
    if (markdown) card.dom.replaceChildren(card.render(markdown));
    else card.close();
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
      for (const set of currentSets(sets, false))
        if (!set.tree && String(set.path) === String(ctx.path)) {
          for (const item of set.items) {
            const className = Object.hasOwn(colors, item.style) ? styles[item.style] : undefined;
            if (!className) continue;
            const from = offset(doc, item.range.start),
              to = offset(doc, item.range.end);
            if (from == null || to == null || from > to) continue;
            const markdown = item.markdownHover || null;
            if (markdown)
              hovers.push({
                doc,
                plugin,
                path: ctx.path,
                range: item.range,
                from,
                to,
                after: item.after,
                markdown,
              });
            if (from < to)
              ranges.push(
                Decoration.mark({
                  class: className,
                  attributes: item.hover && !markdown ? { title: item.hover } : {},
                }).range(from, to),
              );
            if (item.after) {
              // The message belongs at the line end even when the diagnostic's range ends
              // mid-line (a typo in the middle of a long line). `side: 1` keeps it after the
              // caret there; the inline blame steps past it, so: git hint | lens | blame.
              const end = doc.lineAt(to);
              ranges.push(
                Decoration.widget({
                  widget: new AfterText(item.after, className, item.hover, markdown),
                  side: 1,
                }).range(end.to),
              );
            }
          }
        }
    return { decorations: Decoration.set(ranges, true), hovers };
  };

  const tooltip: ReturnType<typeof hoverTooltip> = hoverTooltip(
    markdownHover(
      field,
      ctx,
      (view) => view.dispatch({ effects: closeHoverTooltip(tooltip) }),
      (view, pos, side) => activateHover(view, pos, side, { tooltip }),
    ),
    { hideOnChange: true },
  );
  return [field, tooltip];
}

/**
 * The decoration under the pointer, preferring an `after` label when the
 * pointer is on its widget rather than on the decorated text.
 */
function markdownHover(
  field: StateField<PlacedDecorations>,
  ctx: EditorDocContext,
  close: (view: EditorView) => void,
  lock: (view: EditorView, pos: number, side: -1 | 1) => void,
) {
  const active = new WeakMap<EditorView, { placed: PlacedHover; fromLabel: boolean; tooltip: Tooltip }>();
  return (view: EditorView, pos: number, side: -1 | 1): Tooltip | null => {
    const hovers = view.state.field(field).hovers;
    // An after label is a widget at the line end, past the range when the
    // annotation ends mid-line.
    const labelPos = (h: PlacedHover) => (h.after ? view.state.doc.lineAt(h.to).to : null);
    const candidates = hovers.filter((h) => (h.from <= pos && pos <= h.to) || pos === labelPos(h));
    const placed = candidates.find((h) => labelPos(h) === pos && side >= 0) ?? candidates[candidates.length - 1];
    if (!placed) return null;
    const fromLabel = !!placed.after && labelPos(placed) === pos && side >= 0;
    const current = active.get(view);
    if (
      current?.placed.plugin === placed.plugin &&
      current.fromLabel === fromLabel &&
      sameRange(current.placed.range, placed.range) &&
      current.placed.after === placed.after
    )
      return current.tooltip;
    let label: HTMLElement | undefined;
    let mounted = false;
    const anchor = fromLabel
      ? () => {
          // The widget sits at the line end (AfterText), which can be past the
          // range end when the annotation ends mid-line.
          const labelPos = view.state.doc.lineAt(placed.to).to;
          if (!label?.isConnected) {
            const matches = [...view.dom.querySelectorAll<HTMLElement>(`.${styles.after}`)].filter(
              (node) => node.textContent === placed.after && view.posAtDOM(node) === labelPos,
            );
            label = matches.length === 1 ? matches[0] : undefined;
          }
          if (!label && mounted)
            queueMicrotask(() => {
              if (active.get(view)?.tooltip === tooltip) close(view);
            });
          return label ?? null;
        }
      : undefined;
    if (anchor && !anchor()) return null;
    const tooltip: Tooltip = {
      pos: fromLabel ? (labelPos(placed) ?? placed.to) : placed.from,
      end: placed.to,
      above: true,
      create: () => {
        const sourceEditor = { path: placed.path, language: ctx.language, selections: [placed.range] };
        let links: ReturnType<typeof prepareDecorationFileLinks> | undefined;
        const render = (markdown: string) => {
          links?.dispose();
          const version = versions.get(placed.plugin);
          links = prepareDecorationFileLinks(
            placed.plugin,
            sourceEditor,
            () => view.state.doc === placed.doc && versions.get(placed.plugin) === version,
            () => !refreshing,
          );
          return renderPluginMarkdown(markdown, ctx.uiMode, links.onLink);
        };
        const hover = resizableDecorationHover(view, render(placed.markdown), {
          anchor,
          position: fromLabel ? (labelPos(placed) ?? placed.to) : placed.from,
          close: () => close(view),
          containsSource: (event) => {
            if (!(event.target instanceof Node) || !view.contentDOM.contains(event.target)) return false;
            const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
            return at != null && ((placed.from <= at && at <= placed.to) || at === labelPos(placed));
          },
        });
        const card: OpenHover = {
          invalidate: () => {
            links?.dispose();
          },
          plugin: placed.plugin,
          path: placed.path,
          range: placed.range,
          after: placed.after,
          close: () => close(view),
          dom: hover.content,
          render,
        };
        openHovers.add(card);
        let live = true;
        return {
          ...hover,
          mount: () => {
            mounted = true;
            // Activate only our provider, after CodeMirror finishes creating its tooltip views.
            queueMicrotask(() => {
              if (live) lock(view, pos, side);
            });
          },
          destroy: () => {
            live = false;
            mounted = false;
            links?.dispose();
            hover.destroy?.();
            openHovers.delete(card);
            if (active.get(view)?.tooltip === tooltip) active.delete(view);
          },
        };
      },
    };
    active.set(view, { placed, fromLabel, tooltip });
    return tooltip;
  };
}

/** Native events are invalidations: only the current host's snapshot supplies metadata. */
export function refreshPluginDecorations() {
  const at = ++revision;
  const before = new Map(versions);
  const project = useProject.getState().project;
  const root = project?.root;
  const remote = useRemote.getState().session;
  const remoteIdentity = JSON.stringify(remote);
  if (
    !isTauri() ||
    !project ||
    useProject.getState().opening ||
    (remote && (remote.root !== root || !remote.commands.includes("plugin_decoration_sets")))
  )
    return;
  const current = () =>
    at === revision &&
    useProject.getState().project === project &&
    project.root === root &&
    !useProject.getState().opening &&
    useRemote.getState().session === remote &&
    JSON.stringify(remote) === remoteIdentity;
  refreshing = true;
  // Session subscribers run before enableRemote installs its invoke route.
  void Promise.resolve()
    .then(() => (current() ? commands.pluginDecorationSets() : null))
    .then((all) => {
      if (!all || !current()) return;
      refreshing = false;
      for (const plugin of snapshots.keys())
        if (!all[plugin] && versions.get(plugin) === before.get(plugin)) setPluginDecorations(plugin, []);
      for (const [plugin, sets] of Object.entries(all))
        if (
          versions.get(plugin) === before.get(plugin) &&
          JSON.stringify(snapshots.get(plugin)) !== JSON.stringify(sets)
        )
          setPluginDecorations(plugin, sets);
    })
    .catch((error: unknown) => {
      if (!current()) return;
      refreshing = false;
      for (const plugin of snapshots.keys()) setPluginDecorations(plugin, []);
      logError("cannot refresh plugin annotations", error);
      notifications().notify({
        group: "plugins",
        key: "plugins.decorations",
        level: "warning",
        title: tx("Cannot refresh plugin annotations"),
        body: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Catch up editors and project trees opened after publication. */
export function startPluginDecorations(): () => void {
  const offAction = registerAction(openDecorationFileAction);
  const reset = () => {
    ++revision;
    refreshing = false;
    for (const plugin of snapshots.keys()) setPluginDecorations(plugin, []);
    if (!useProject.getState().opening) refreshPluginDecorations();
  };
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project !== prev.project || s.opening !== prev.opening) reset();
  });
  const offRemote = useRemote.subscribe((s, prev) => {
    if (s.session !== prev.session) reset();
  });
  const off = registerEditorContribution({
    id: "plugins.decorations",
    extensions: decorationExtension,
  });
  refreshPluginDecorations();
  return () => {
    ++revision;
    refreshing = false;
    offProject();
    offRemote();
    offAction();
    off();
    for (const plugin of snapshots.keys()) setPluginDecorations(plugin, []);
    snapshots.clear();
    versions.clear();
  };
}
