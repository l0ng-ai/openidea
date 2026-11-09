import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet as CmDecorations } from "@codemirror/view";
import type { DecorationSet, Range } from "@/bindings";
import { registerEditorContribution, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { commands, isTauri } from "@/platform/ipc";
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
  ) {
    super();
  }
  override eq(other: AfterText) {
    return this.text === other.text && this.style === other.style && this.hover === other.hover;
  }
  override toDOM() {
    const span = document.createElement("span");
    span.className = `${styles.after} ${this.style}`;
    span.textContent = this.text;
    if (this.hover) span.title = this.hover;
    return span;
  }
}

export function decorationExtension(ctx: EditorDocContext) {
  const build = (doc: Text): CmDecorations => {
    const ranges = [];
    for (const sets of snapshots.values())
      for (const set of currentSets(sets))
        if (!set.tree && set.path === ctx.path) {
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
            if (item.after)
              ranges.push(
                Decoration.widget({ widget: new AfterText(item.after, className, item.hover), side: 1 }).range(to),
              );
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
