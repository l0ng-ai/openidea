/** Annotate (git blame) gutter left of the line numbers. */
import { Compartment, Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { BlameLine } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { showContextMenu } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { formatDate } from "./model";
import { useVcs } from "./store";

const ZERO = /^0+$/;

export function isUncommitted(line: Pick<BlameLine, "commit">): boolean {
  return ZERO.test(line.commit);
}

export function shortAuthor(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

/** 0 (oldest) … 1 (newest) per line, for age colouring. */
export function ageRanks(lines: readonly Pick<BlameLine, "timeMs" | "commit">[]): number[] {
  const times = lines.filter((l) => !isUncommitted(l) && l.timeMs).map((l) => l.timeMs!);
  if (!times.length) return lines.map(() => 1);
  const min = Math.min(...times);
  const max = Math.max(...times);
  return lines.map((l) => (isUncommitted(l) || !l.timeMs ? 1 : max === min ? 1 : (l.timeMs - min) / (max - min)));
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly line: BlameLine,
    readonly rank: number,
  ) {
    super();
  }
  eq(o: BlameMarker) {
    return o.line.commit === this.line.commit && o.rank === this.rank;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-blame-line";
    const l = this.line;
    if (isUncommitted(l)) {
      el.textContent = "";
      el.title = "Not committed yet";
      return el;
    }
    const author = document.createElement("span");
    author.className = "cm-vcs-blame-author";
    author.textContent = shortAuthor(l.author);
    const date = document.createElement("span");
    date.className = "cm-vcs-blame-date";
    date.textContent = formatDate(l.timeMs);
    el.append(date, author);
    const pct = Math.round(25 + this.rank * 75);
    el.style.color = `color-mix(in srgb, var(--fg-secondary) ${pct}%, var(--fg-gutter))`;
    el.title = `${l.commit.slice(0, 8)}  ${l.author}  ${l.timeMs ? new Date(l.timeMs).toLocaleString() : ""}\n${l.summary}`;
    return el;
  }
}

const spacer = new BlameMarker({ commit: "f", author: "Mmmmmmmm", timeMs: Date.UTC(2020, 11, 28), summary: "" }, 1);

const setBlame = StateEffect.define<BlameLine[]>();

interface BlameState {
  lines: BlameLine[];
  markers: RangeSet<GutterMarker>;
}

function build(lines: readonly BlameLine[], doc: Text): RangeSet<GutterMarker> {
  const ranks = ageRanks(lines);
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let i = 0; i < n; i++) out.push(new BlameMarker(lines[i]!, ranks[i]!).range(doc.line(i + 1).from));
  return RangeSet.of(out);
}

const blameField = StateField.define<BlameState>({
  create: () => ({ lines: [], markers: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return { lines: e.value, markers: build(e.value, tr.state.doc) };
    return tr.docChanged ? { ...value, markers: value.markers.map(tr.changes) } : value;
  },
});

/** Re-blames after edits and whenever HEAD moves (commit, Undo Commit, update, checkout). */
class BlameRefresher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private readonly offHead: () => void;
  constructor(
    private readonly view: EditorView,
    private readonly path: string,
  ) {
    this.offHead = useVcs.subscribe((s, p) => {
      if (s.branch?.headCommit !== p.branch?.headCommit) this.schedule(100);
    });
  }
  update(u: ViewUpdate) {
    if (u.docChanged) this.schedule(800);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void call(commands.vcsBlame(this.path, null))
        .then((lines) => {
          if (!this.destroyed && this.view.state.field(blameField, false))
            this.view.dispatch({ effects: setBlame.of(lines) });
        })
        .catch(() => undefined);
    }, delay);
  }
  destroy() {
    this.destroyed = true;
    this.offHead();
    clearTimeout(this.timer);
  }
}

const blameTheme = EditorView.baseTheme({
  ".cm-vcs-blame": { cursor: "pointer", borderRight: "1px solid var(--border)" },
  ".cm-vcs-blame .cm-gutterElement": { padding: "0 8px 0 6px" },
  ".cm-vcs-blame-line": {
    display: "inline-flex",
    gap: "8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    whiteSpace: "nowrap",
  },
  ".cm-vcs-blame-date": { minWidth: "7ch", fontVariantNumeric: "tabular-nums" },
  ".cm-vcs-blame-author": { minWidth: "9ch" },
  ".cm-vcs-blame .cm-gutterElement:hover .cm-vcs-blame-line": { color: "var(--fg-strong)" },
});

export const blameCompartment = new Compartment();

/** Placeholder included in every editor so annotations can be toggled. */
export function blameSlot(): Extension {
  return blameCompartment.of([]);
}

function lineAt(view: EditorView, from: number): BlameLine | undefined {
  const st = view.state.field(blameField, false);
  if (!st) return undefined;
  let found: BlameLine | undefined;
  st.markers.between(from, from, (f, _t, m) => {
    if (f === from) found = (m as BlameMarker).line;
  });
  return found;
}

function blameExtension(lines: BlameLine[], path: string, live: boolean): Extension {
  return [
    blameField.init((state) => ({ lines, markers: build(lines, state.doc) })),
    Prec.high(
      gutter({
        class: "cm-vcs-blame",
        markers: (v) => v.state.field(blameField).markers,
        initialSpacer: () => spacer,
        domEventHandlers: {
          click(view, block) {
            const l = lineAt(view, block.from);
            if (l && !isUncommitted(l)) void executeAction("vcs.showCommit", l.commit);
            return true;
          },
          contextmenu(view, block, event) {
            const l = lineAt(view, block.from);
            event.preventDefault();
            showContextMenu(event as MouseEvent, [
              ...(l && !isUncommitted(l)
                ? [
                    {
                      label: "Show Commit in Git Log",
                      icon: "commit",
                      run: () => void executeAction("vcs.showCommit", l.commit),
                    },
                    {
                      label: "Copy Revision Number",
                      icon: "copy",
                      run: () => void navigator.clipboard?.writeText(l.commit),
                    },
                    { kind: "separator" as const },
                  ]
                : []),
              { label: "Close Annotations", run: () => setAnnotations(view, null, path, false) },
            ]);
            return true;
          },
        },
      }),
    ),
    // Static content (a merge pane's side) is not re-blamed on edits / HEAD moves.
    ...(live ? [ViewPlugin.define((view) => new BlameRefresher(view, path))] : []),
    blameTheme,
  ];
}

export function annotationsShown(view: EditorView): boolean {
  return !!view.state.field(blameField, false);
}

function setAnnotations(view: EditorView, lines: BlameLine[] | null, path: string, live: boolean) {
  view.dispatch({ effects: blameCompartment.reconfigure(lines ? blameExtension(lines, path, live) : []) });
}

/** Toggles annotations in `view`; `text` blames that content instead of the file on disk. */
export async function toggleAnnotations(view: EditorView, path: string, text?: string) {
  if (annotationsShown(view)) {
    setAnnotations(view, null, path, false);
    return;
  }
  try {
    const lines = await call(commands.vcsBlame(path, text ?? null));
    setAnnotations(view, lines, path, text === undefined);
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot annotate",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
