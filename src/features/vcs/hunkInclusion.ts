/**
 * Partial commit by changed block (as IDEA):
 * in a local-changes diff each changed block gets a gutter checkbox that includes it in
 * the next commit or leaves it out; the file's checkbox in the commit tree goes
 * tri-state. `commitChanges` then commits only the included blocks.
 */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { LineHunk } from "@/bindings";
import { tx } from "@/platform/i18n";
import { commands } from "@/platform/ipc";
import { checkOf, hunkIncluded, toggledHunk } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { stagingAreaOn } from "./staging";
import { useCommit } from "./commitStore";
import { hunkKeys } from "./hunks";
import { statusOf, useVcs } from "./store";

interface Block {
  /** 0-based line of the right side the checkbox sits on. */
  line: number;
  key: string;
}

const setBlocks = StateEffect.define<Block[]>();
/** Inclusion changed elsewhere (the commit tree, another diff): redraw. */
const refresh = StateEffect.define<null>();

const blocksField = StateField.define<Block[]>({
  create: () => [],
  update: (v, tr) => tr.effects.find((e) => e.is(setBlocks))?.value ?? v,
});

/** The effective inclusion of `path` (change list defaults applied). */
function inclusionOf(path: string) {
  const fs = statusOf(path);
  // With the staging area, blocks go into the commit by staging them, not by checkboxes.
  if (!fs || stagingAreaOn()) return null;
  const { status, root } = useVcs.getState();
  const { checks, excludedHunks } = useCommit.getState();
  const effective = withListDefaults(status, root ?? "", useChangelists.getState().state, checks);
  return { key: fs.path, check: checkOf(fs, effective), excluded: excludedHunks.get(fs.path) };
}

/** Includes / excludes one changed block of `path`; `all` are the keys of every block. */
export function toggleBlock(path: string, all: readonly string[], key: string) {
  const cur = inclusionOf(path);
  if (!cur) return;
  const next = toggledHunk(cur.check, cur.excluded, all, key);
  const { checks, excludedHunks } = useCommit.getState();
  const nextChecks = new Map(checks).set(cur.key, next.check);
  const nextExcluded = new Map(excludedHunks);
  if (next.excluded.size) nextExcluded.set(cur.key, next.excluded);
  else nextExcluded.delete(cur.key);
  useCommit.setState({ checks: nextChecks, excludedHunks: nextExcluded });
}

class CheckboxMarker extends GutterMarker {
  constructor(
    readonly path: string,
    readonly key: string,
    readonly all: readonly string[],
    readonly checked: boolean,
  ) {
    super();
  }
  eq(o: CheckboxMarker) {
    return o.key === this.key && o.checked === this.checked && o.all.length === this.all.length;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-include-hunk";
    box.checked = this.checked;
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
      constructor(readonly view: EditorView) {
        this.schedule(0);
        this.unsubscribe = useCommit.subscribe((s, p) => {
          if (s.checks !== p.checks || s.excludedHunks !== p.excludedHunks)
            queueMicrotask(() => this.live && this.view.dispatch({ effects: refresh.of(null) }));
        });
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
        if (seq !== this.seq || !this.live) return;
        const keys = hunkKeys(text, hunks);
        const lines = this.view.state.doc.lines;
        const blocks = hunks.map((h, i) => ({ line: Math.min(h.start, lines - 1), key: keys[i]! }));
        this.view.dispatch({ effects: setBlocks.of(blocks) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.unsubscribe();
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
      ranges.push(new CheckboxMarker(path, b.key, all, checked).range(doc.line(b.line + 1).from));
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
