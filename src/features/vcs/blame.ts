/** Annotate (git blame) gutter left of the line numbers. */
import { writeClipboardText } from "@/platform/clipboard";
import { Compartment, Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { BlameLine } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { showContextMenu } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { closeBlamePopup, scheduleCloseBlamePopup, scheduleOpenBlamePopup } from "./BlamePopup";
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

const BLAME_PALETTE = [
  "var(--project-color-5)",
  "var(--project-color-7)",
  "var(--project-color-4)",
  "var(--project-color-8)",
  "var(--project-color-6)",
  "var(--project-color-1)",
  "var(--project-color-2)",
  "var(--project-color-9)",
  "var(--project-color-3)",
] as const;

/** Assigns each distinct commit in the file a background tint ordered from oldest (cool) to newest (warm/green). */
export function commitBackgrounds(lines: readonly Pick<BlameLine, "timeMs" | "commit">[]): Map<string, string> {
  const unique = new Map<string, number>();
  for (const l of lines) {
    if (isUncommitted(l)) continue;
    const prev = unique.get(l.commit);
    const t = l.timeMs ?? 0;
    if (prev === undefined || t > prev) unique.set(l.commit, t);
  }
  const sorted = [...unique.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, string>();
  const count = sorted.length;
  for (let i = 0; i < count; i++) {
    const [commit] = sorted[i]!;
    const t = count <= 1 ? 1 : i / (count - 1);
    const scaled = t * (BLAME_PALETTE.length - 1);
    const idx = Math.floor(scaled);
    const frac = Math.round((scaled - idx) * 100);
    const hue =
      frac === 0 || idx >= BLAME_PALETTE.length - 1
        ? BLAME_PALETTE[idx]!
        : `color-mix(in srgb, ${BLAME_PALETTE[idx + 1]!} ${frac}%, ${BLAME_PALETTE[idx]!})`;
    const strength = count > BLAME_PALETTE.length && i % 2 === 1 ? 24 : 18;
    out.set(commit, `color-mix(in srgb, ${hue} ${strength}%, var(--bg-editor-gutter))`);
  }
  return out;
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly line: BlameLine,
    readonly bg = "",
  ) {
    super();
  }
  eq(o: BlameMarker) {
    return o.line.commit === this.line.commit && o.bg === this.bg;
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
    if (this.bg) {
      el.style.setProperty("--blame-bg", this.bg);
      el.style.backgroundColor = this.bg;
    }
    el.dataset.commit = l.commit;
    return el;
  }
}

const spacer = new BlameMarker({ commit: "f", author: "Mmmmmmmm", timeMs: Date.UTC(2020, 11, 28), summary: "" });

const setBlame = StateEffect.define<BlameLine[]>();

interface BlameState {
  lines: BlameLine[];
  markers: RangeSet<GutterMarker>;
}

function build(lines: readonly BlameLine[], doc: Text): RangeSet<GutterMarker> {
  const bgs = commitBackgrounds(lines);
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    out.push(new BlameMarker(line, bgs.get(line.commit) ?? "").range(doc.line(i + 1).from));
  }
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
      void call(commands.vcsBlame(this.path, null, null))
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
  ".cm-vcs-blame .cm-gutterElement": { padding: "0", display: "flex", alignItems: "stretch" },
  ".cm-vcs-blame-line": {
    flex: "1",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 8px 0 6px",
    color: "var(--fg-secondary)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    whiteSpace: "nowrap",
  },
  ".cm-vcs-blame-date": { minWidth: "7ch", fontVariantNumeric: "tabular-nums" },
  ".cm-vcs-blame-author": { minWidth: "9ch" },
  ".cm-vcs-blame .cm-gutterElement:hover .cm-vcs-blame-line, .cm-vcs-blame .cm-gutterElement.cm-vcs-blame-same-commit .cm-vcs-blame-line":
    {
      color: "var(--fg-strong)",
      backgroundColor: "color-mix(in srgb, var(--fg-strong) 10%, var(--blame-bg, var(--bg-tree-hover)))",
    },
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

function highlightSameCommit(view: EditorView, commit: string | null) {
  for (const el of view.dom.querySelectorAll<HTMLElement>(".cm-vcs-blame .cm-gutterElement")) {
    const line = el.querySelector<HTMLElement>(".cm-vcs-blame-line");
    el.classList.toggle("cm-vcs-blame-same-commit", !!commit && line?.dataset.commit === commit);
  }
}

class BlameInteraction implements PluginValue {
  private readonly onScroll = () => {
    highlightSameCommit(this.view, null);
    closeBlamePopup(this.view);
  };
  private readonly onLeave = (e: MouseEvent) => {
    const gutterEl = this.view.dom.querySelector(".cm-vcs-blame");
    if (gutterEl && e.relatedTarget instanceof Node && gutterEl.contains(e.relatedTarget)) return;
    highlightSameCommit(this.view, null);
    scheduleCloseBlamePopup();
  };
  constructor(private readonly view: EditorView) {
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.view.dom.addEventListener("mouseout", this.onLeave);
  }
  update(u: ViewUpdate) {
    if (u.docChanged) {
      highlightSameCommit(this.view, null);
      closeBlamePopup(this.view);
    }
  }
  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view.dom.removeEventListener("mouseout", this.onLeave);
    highlightSameCommit(this.view, null);
    closeBlamePopup(this.view);
  }
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
          mouseover(view, block, event) {
            const l = lineAt(view, block.from);
            const anchor = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(".cm-gutterElement");
            if (!l || isUncommitted(l) || !anchor) {
              highlightSameCommit(view, null);
              scheduleCloseBlamePopup();
              return false;
            }
            highlightSameCommit(view, l.commit);
            scheduleOpenBlamePopup({ view, anchor, line: l, path });
            return false;
          },
          click(view, block) {
            closeBlamePopup(view);
            const l = lineAt(view, block.from);
            if (l && !isUncommitted(l)) void executeAction("vcs.showCommit", l.commit);
            return true;
          },
          contextmenu(view, block, event) {
            closeBlamePopup(view);
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
                      run: () => void writeClipboardText(l.commit),
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
    ViewPlugin.define((view) => new BlameInteraction(view)),
    // Static content (a merge pane's side) is not re-blamed on edits / HEAD moves.
    ...(live ? [ViewPlugin.define((view) => new BlameRefresher(view, path))] : []),
    blameTheme,
  ];
}

export function annotationsShown(view: EditorView): boolean {
  return !!view.state.field(blameField, false);
}

function setAnnotations(view: EditorView, lines: BlameLine[] | null, path: string, live: boolean) {
  if (!lines) closeBlamePopup(view);
  view.dispatch({ effects: blameCompartment.reconfigure(lines ? blameExtension(lines, path, live) : []) });
}

/** Toggles annotations in `view`; `text` blames that content instead of the file on
 * disk, `revision` the history it is blamed on (default HEAD). */
export async function toggleAnnotations(view: EditorView, path: string, text?: string, revision?: string) {
  if (annotationsShown(view)) {
    setAnnotations(view, null, path, false);
    return;
  }
  try {
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null));
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
