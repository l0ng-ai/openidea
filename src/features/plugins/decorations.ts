import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet as CmDecorations } from "@codemirror/view";
import type { DecorationSet, Range } from "@/bindings";
import { registerEditorContribution, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { addPathIconProvider, bumpFileIconRevision } from "@/ui";
import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";
import styles from "./decorations.module.css";

const snapshots = new Map<string, DecorationSet[]>();
const pluginIcons = new Map<string, Map<string, string>>();
let removePathIcons: (() => void) | null = null;
const refresh = StateEffect.define<null>();
const versions = new Map<string, number>();

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
  ) {
    super();
  }
  override eq(other: AfterText) {
    return this.text === other.text && this.style === other.style && this.hover === other.hover;
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
    // The hint's inner box sits `--openidea-hint-offset` past its zero-width anchor.
    let width = hint ? Math.round(hint.getBoundingClientRect().width) + offsetOf(hint, "--openidea-hint-offset") : 0;
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
    if (this.hover) text.title = this.hover;
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

export function decorationExtension(ctx: EditorDocContext) {
  const build = (doc: Text): CmDecorations => {
    const ranges = [];
    for (const sets of snapshots.values())
      for (const set of currentSets(sets, false))
        if (!set.tree && String(set.path) === String(ctx.path)) {
          for (const item of set.items) {
            const className = Object.hasOwn(colors, item.style) ? styles[item.style] : undefined;
            if (!className) continue;
            const from = offset(doc, item.range.start),
              to = offset(doc, item.range.end);
            if (from == null || to == null || from > to) continue;
            if (from < to)
              ranges.push(
                Decoration.mark({ class: className, attributes: item.hover ? { title: item.hover } : {} }).range(
                  from,
                  to,
                ),
              );
            if (item.after) {
              // The message belongs at the line end even when the diagnostic's range ends
              // mid-line (a typo in the middle of a long line). `side: 1` keeps it after the
              // caret there; the inline blame steps past it, so: git hint | lens | blame.
              const end = doc.lineAt(to);
              ranges.push(
                Decoration.widget({ widget: new AfterText(item.after, className, item.hover), side: 1 }).range(end.to),
              );
            }
          }
        }
    return Decoration.set(ranges, true);
  };
  return StateField.define<CmDecorations>({
    create: (state) => build(state.doc),
    update: (value, tr) => (tr.effects.some((e) => e.is(refresh)) ? build(tr.state.doc) : value.map(tr.changes)),
    provide: (field) => EditorView.decorations.from(field),
  });
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
  const off = registerEditorContribution({ id: "plugins.decorations", extensions: decorationExtension });
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
