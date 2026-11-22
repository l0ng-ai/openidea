/**
 * Commit inclusion for a local-changes diff. The gutter controls whole blocks;
 * the pane's selection can include or exclude individual changed lines.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { LineHunk } from "@/bindings";
import { tx } from "@/platform/i18n";
import { commands } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { checkOf, hunkIncluded } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { stagingAreaOn } from "./staging";
import { useCommit, type ExcludedHunkLines } from "./commitStore";
import { hunkKeys } from "./hunks";
import { statusOf, useVcs } from "./store";

interface Block extends LineHunk {
  /** 0-based line of the right side the checkbox sits on. */
  line: number;
  key: string;
}

const setBlocks = StateEffect.define<Block[]>();
/** Inclusion changed elsewhere (the commit tree, another diff): redraw. */
const refresh = StateEffect.define<null>();

const blocksField = StateField.define<Block[]>({
  create: () => [],
  update: (v, tr) => tr.effects.find((e) => e.is(setBlocks))?.value ?? (tr.docChanged ? [] : v),
});

/** The effective inclusion of `path` (change list defaults applied). */
function inclusionOf(path: string) {
  const fs = statusOf(path);
  // With the staging area, blocks go into the commit by staging them, not by checkboxes.
  if (!fs || stagingAreaOn()) return null;
  const { status, root } = useVcs.getState();
  const { checks, excludedHunks, excludedHunkLines } = useCommit.getState();
  const effective = withListDefaults(status, root ?? "", useChangelists.getState().state, checks);
  const check = checkOf(fs, effective, workflowSettings().vcs.commit.includeChangesByDefault);
  return { key: fs.path, check, excluded: excludedHunks.get(fs.path), lines: excludedHunkLines.get(fs.path) };
}

function editInclusion(
  path: string,
  all: readonly string[],
  edit: (excluded: Set<string>, lines: Map<string, ExcludedHunkLines>) => void,
) {
  const cur = inclusionOf(path);
  if (!cur) return;
  const excluded = new Set(
    cur.check === "none" ? all : cur.check === "hunks" ? all.filter((key) => cur.excluded?.has(key)) : [],
  );
  const lines = new Map(cur.check === "hunks" && cur.lines ? [...cur.lines].filter(([key]) => all.includes(key)) : []);
  edit(excluded, lines);
  const allExcluded = all.every((key) => excluded.has(key));
  const check = allExcluded ? "none" : excluded.size || lines.size ? "hunks" : "all";
  const state = useCommit.getState();
  const excludedHunks = new Map(state.excludedHunks);
  const excludedHunkLines = new Map(state.excludedHunkLines);
  if (check === "hunks" && excluded.size) excludedHunks.set(cur.key, excluded);
  else excludedHunks.delete(cur.key);
  if (check === "hunks" && lines.size) excludedHunkLines.set(cur.key, lines);
  else excludedHunkLines.delete(cur.key);
  useCommit.setState({ checks: new Map(state.checks).set(cur.key, check), excludedHunks, excludedHunkLines });
}

/** Includes / excludes one changed block of `path`; `all` are the keys of every block. */
export function toggleBlock(path: string, all: readonly string[], key: string) {
  editInclusion(path, all, (excluded, lines) => {
    if (!excluded.delete(key)) excluded.add(key);
    lines.delete(key);
  });
}

type Side = keyof ExcludedHunkLines;
const sides = ["old", "current"] as const;

export type DiffLineSelection = Partial<Record<Side, readonly { first: number; last: number }[]>>;

interface CommitLineTarget {
  path: string;
  view: EditorView;
  selection: DiffLineSelection;
}

export const INCLUDE_COMMIT_LINES = "vcs.includeSelectedLinesInCommit";
export const EXCLUDE_COMMIT_LINES = "vcs.excludeSelectedLinesFromCommit";

export function commitLineTarget(arg: unknown, include?: boolean): CommitLineTarget | null {
  if (!arg || typeof arg !== "object") return null;
  const { path, view, selection } = arg as Partial<CommitLineTarget>;
  if (
    typeof path !== "string" ||
    !(view instanceof EditorView) ||
    !view.dom.isConnected ||
    !selection ||
    !sides.some((side) => Array.isArray(selection[side]))
  )
    return null;
  const current = inclusionOf(path);
  if (!current) return null;
  const changes = selectedCommitLines(view, selection);
  const canChange = changes.some(({ block, offsets }) => {
    if (include === undefined) return true;
    const hunk = hunkIncluded(current.check, current.excluded, block.key);
    const excluded = current.check === "hunks" ? current.lines?.get(block.key) : undefined;
    return sides.some((side) => offsets[side].some((offset) => (hunk && !excluded?.[side].has(offset)) !== include));
  });
  return canChange ? { path, view, selection } : null;
}

function selectedCommitLines(view: EditorView, selection: DiffLineSelection) {
  return (view.state.field(blocksField, false) ?? []).flatMap((block) => {
    const offsets = { old: [] as number[], current: [] as number[] };
    for (const side of sides) {
      const start = side === "old" ? block.oldStart : block.start;
      const count = side === "old" ? block.oldLines : block.lines;
      for (const range of selection[side] ?? []) {
        for (let line = Math.max(range.first, start); line <= Math.min(range.last, start + count - 1); line++) {
          offsets[side].push(line - start);
        }
      }
    }
    return offsets.old.length || offsets.current.length ? [{ block, offsets }] : [];
  });
}

export function setCommitLineInclusion(path: string, view: EditorView, selection: DiffLineSelection, include: boolean) {
  const blocks = view.state.field(blocksField, false) ?? [];
  const changes = selectedCommitLines(view, selection);
  if (!changes.length) return;
  editInclusion(
    path,
    blocks.map(({ key }) => key),
    (excluded, lines) => {
      for (const { block, offsets } of changes) {
        const { key, oldLines, lines: currentLines } = block;
        const whole = excluded.delete(key);
        const previous = lines.get(key);
        const next = {
          old: new Set(whole ? allOffsets(oldLines) : previous?.old),
          current: new Set(whole ? allOffsets(currentLines) : previous?.current),
        };
        for (const side of sides) {
          for (const offset of offsets[side]) {
            if (include) next[side].delete(offset);
            else next[side].add(offset);
          }
        }
        if (next.old.size === oldLines && next.current.size === currentLines) {
          excluded.add(key);
          lines.delete(key);
        } else if (next.old.size || next.current.size) {
          lines.set(key, next);
        } else lines.delete(key);
      }
    },
  );
}

const allOffsets = (count: number) => Array.from({ length: count }, (_, line) => line);

class CheckboxMarker extends GutterMarker {
  constructor(
    readonly path: string,
    readonly key: string,
    readonly all: readonly string[],
    readonly checked: boolean,
    readonly partial: boolean,
  ) {
    super();
  }
  eq(o: CheckboxMarker) {
    return (
      o.key === this.key && o.checked === this.checked && o.partial === this.partial && o.all.length === this.all.length
    );
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-include-hunk";
    box.checked = this.checked;
    box.indeterminate = this.partial;
    box.setAttribute("aria-label", tx("Include in commit"));
    box.title = tx("Include in commit");
    box.onmousedown = (e) => e.stopPropagation();
    box.onchange = () => toggleBlock(this.path, this.all, this.key);
    return box;
  }
}

const theme = EditorView.baseTheme({
  ".cm-include-gutter .cm-gutterElement": { display: "flex", alignItems: "center", padding: "0 2px" },
  ".cm-include-hunk": { margin: 0, width: "12px", height: "12px", accentColor: "var(--accent)", cursor: "pointer" },
});

/**
 * Inclusion checkboxes for the changed blocks of `path` (right side of a HEAD ↔ working
 * file diff, `base` being the HEAD text). Blocks follow the backend's hunks, which are
 * what a partial commit applies.
 */
export function inclusionGutter(path: string, base: string): Extension {
  const compute = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      seq = 0;
      live = true;
      unsubscribe: () => void;
      unsubscribeDefault: () => void;
      constructor(readonly view: EditorView) {
        this.schedule(0);
        const redraw = () => queueMicrotask(() => this.live && this.view.dispatch({ effects: refresh.of(null) }));
        this.unsubscribe = useCommit.subscribe((s, p) => {
          if (
            s.checks !== p.checks ||
            s.excludedHunks !== p.excludedHunks ||
            s.excludedHunkLines !== p.excludedHunkLines
          )
            redraw();
        });
        this.unsubscribeDefault = onWorkflowSettingsChange((s) => s.vcs.commit.includeChangesByDefault, redraw);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(250);
      }
      schedule(delay: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), delay);
      }
      async run() {
        const seq = ++this.seq;
        const text = this.view.state.doc.toString();
        let hunks: LineHunk[];
        try {
          hunks = await commands.vcsDiffHunks(base, text);
        } catch {
          return;
        }
        if (seq !== this.seq || !this.live || this.view.state.doc.toString() !== text) return;
        const keys = hunkKeys(text, hunks);
        const lines = this.view.state.doc.lines;
        const blocks = hunks.map((h, i) => ({ ...h, line: Math.min(h.start, lines - 1), key: keys[i]! }));
        this.view.dispatch({ effects: setBlocks.of(blocks) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.unsubscribe();
        this.unsubscribeDefault();
        this.live = false;
      }
    },
  );
  const markers = (view: EditorView) => {
    const blocks = view.state.field(blocksField);
    const cur = inclusionOf(path);
    if (!cur || !blocks.length) return RangeSet.empty;
    const all = blocks.map((b) => b.key);
    const doc = view.state.doc;
    const seen = new Set<number>();
    const ranges = [];
    for (const b of blocks) {
      // Two blocks on one line (a deletion right before a change) share the first box.
      if (seen.has(b.line)) continue;
      seen.add(b.line);
      const checked = hunkIncluded(cur.check, cur.excluded, b.key);
      const partial = cur.check === "hunks" && !!cur.lines?.has(b.key);
      ranges.push(new CheckboxMarker(path, b.key, all, checked, partial).range(doc.line(b.line + 1).from));
    }
    return RangeSet.of(ranges, true);
  };
  return [
    blocksField,
    compute,
    theme,
    gutter({
      class: "cm-include-gutter",
      markers,
      lineMarkerChange: (u) =>
        u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setBlocks) || e.is(refresh))),
    }),
  ];
}
