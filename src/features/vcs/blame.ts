/** Annotate (git blame) gutter left of the line numbers. */
import { writeClipboardText } from "@/platform/clipboard";
import { Compartment, Prec, RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import type { BlameLine } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { showContextMenu, type MenuItem } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { closeBlamePopup, scheduleCloseBlamePopup, scheduleOpenBlamePopup } from "./BlamePopup";
import { formatPrettyDay } from "@/platform/dateFormat";
import { saveVcsSetting } from "./settingsUi";
import { repoOf, useVcs } from "./store";

const ZERO = /^0+$/;

export function isUncommitted(line: Pick<BlameLine, "commit">): boolean {
  return ZERO.test(line.commit);
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

/**
 * How much of each palette colour is blended over the gutter. One strength for every commit: the
 * palette's hue is what identifies a commit, and its weight carries no meaning, so varying it only
 * made neighbours harder to compare. At 18% the nine hues dropped to a chroma of about 20 and
 * adjacent commits read as the same grey; 40% keeps them apart.
 */
const TINT_STRENGTH = 40;

/** A palette colour blended over the gutter at `TINT_STRENGTH`. */
function tinted(hue: string): string {
  return `color-mix(in srgb, ${hue} ${TINT_STRENGTH}%, var(--bg-editor-gutter))`;
}

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
    out.set(commit, tinted(hue));
  }
  return out;
}

const COLUMNS = ["date", "author", "revision"] as const;
const GUTTER_ORDER = ["revision", "date", "author"] as const;
type AnnotateColumn = (typeof COLUMNS)[number];
type AnnotateColumns = Record<AnnotateColumn, boolean>;
type BlameLabels = Record<AnnotateColumn, string>;

class BlameMarker extends GutterMarker {
  constructor(
    readonly line: BlameLine,
    readonly labels: BlameLabels | undefined,
    readonly bg = "",
    readonly current = false,
  ) {
    super();
  }
  eq(o: BlameMarker) {
    return (
      o.line.commit === this.line.commit &&
      o.bg === this.bg &&
      o.current === this.current &&
      COLUMNS.every((column) => o.labels?.[column] === this.labels?.[column])
    );
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-blame-line";
    if (!this.labels) {
      el.title = "Not committed yet";
      return el;
    }
    for (const column of GUTTER_ORDER) {
      const cell = document.createElement("span");
      cell.className = `cm-vcs-blame-${column}`;
      cell.textContent = this.labels[column];
      el.append(cell);
    }
    if (this.bg) {
      el.style.setProperty("--blame-bg", this.bg);
      el.style.backgroundColor = this.bg;
    }
    el.dataset.commit = this.line.commit;
    if (this.current) el.classList.add("cm-vcs-blame-current");
    return el;
  }
}

const spacer = new BlameMarker(
  { commit: "ffffffff", author: "", timeMs: 0, summary: "" },
  { date: "", author: "", revision: "" },
);

/** The columns the gutter shows (IDEA's annotate Options); kept across sessions. */
const COLUMNS_KEY = "openidea.vcs.annotateColumns";
const DEFAULT_COLUMNS: AnnotateColumns = { date: true, author: true, revision: false };

export function readAnnotateColumns(): AnnotateColumns {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null");
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const out = { ...DEFAULT_COLUMNS };
    for (const k of COLUMNS) if (typeof o[k] === "boolean") out[k] = o[k];
    return COLUMNS.some((k) => out[k]) ? out : { ...DEFAULT_COLUMNS };
  } catch {
    return { ...DEFAULT_COLUMNS };
  }
}

export const useAnnotateColumns = create<AnnotateColumns>(() => readAnnotateColumns());

// Other windows (project, diff) annotate too.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === COLUMNS_KEY) useAnnotateColumns.setState(readAnnotateColumns());
  });

/** Shows or hides a column in every annotated editor; the last shown column stays. */
function setAnnotateColumn(column: AnnotateColumn, shown: boolean) {
  const next = { ...useAnnotateColumns.getState(), [column]: shown };
  if (!COLUMNS.some((k) => next[k])) return;
  useAnnotateColumns.setState(next);
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/** How the author column shows names (IDEA's annotate Options › Names; Last Name by default, as there); kept across sessions. */
const NAMES_KEY = "openidea.vcs.annotateNames";
const NAME_TYPES = ["initials", "lastName", "firstName", "fullName"] as const;
type AnnotateNames = (typeof NAME_TYPES)[number];

export function readAnnotateNames(): AnnotateNames {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    return NAME_TYPES.find((t) => t === raw) ?? "lastName";
  } catch {
    return "lastName";
  }
}

export const useAnnotateNames = create<{ names: AnnotateNames }>(() => ({ names: readAnnotateNames() }));

if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === NAMES_KEY) setAnnotateNames(readAnnotateNames(), false);
  });

function setAnnotateNames(names: AnnotateNames, save = true) {
  if (useAnnotateNames.getState().names === names) return;
  useAnnotateNames.setState({ names });
  if (!save) return;
  try {
    localStorage.setItem(NAMES_KEY, names);
  } catch {
    // ignore
  }
}

/** How the gutter is tinted (IDEA's annotate Options › Colors; Order by default, as there); kept across sessions. */
const COLORS_KEY = "openidea.vcs.annotateColors";
const COLOR_MODES = ["author", "order", "hide"] as const;
type AnnotateColors = (typeof COLOR_MODES)[number];

export function readAnnotateColors(): AnnotateColors {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    return COLOR_MODES.find((m) => m === raw) ?? "order";
  } catch {
    return "order";
  }
}

export const useAnnotateColors = create<{ colors: AnnotateColors }>(() => ({ colors: readAnnotateColors() }));

if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === COLORS_KEY) setAnnotateColors(readAnnotateColors(), false);
  });

function setAnnotateColors(colors: AnnotateColors, save = true) {
  if (useAnnotateColors.getState().colors === colors) return;
  useAnnotateColors.setState({ colors });
  if (!save) return;
  try {
    localStorage.setItem(COLORS_KEY, colors);
  } catch {
    // ignore
  }
}

/** IDEA's ColorMode.AUTHOR: authors sorted by name take the palette colours in turn, keyed by commit. */
function authorBackgrounds(lines: readonly BlameLine[]): Map<string, string> {
  const committed = lines.filter((l) => !isUncommitted(l));
  const authors = [...new Set(committed.map((l) => l.author))].sort();
  const tint = new Map(authors.map((a, i) => [a, tinted(BLAME_PALETTE[i % BLAME_PALETTE.length]!)]));
  return new Map(committed.map((l) => [l.commit, tint.get(l.author)!]));
}

function backgrounds(lines: readonly BlameLine[]): Map<string, string> {
  const { colors } = useAnnotateColors.getState();
  if (colors === "hide") return new Map();
  return colors === "author" ? authorBackgrounds(lines) : commitBackgrounds(lines);
}

/** Characters IDEA's ShortNameType splits an email's local part and initials on. */
const NAME_DELIMITERS = /[.,<>()":_-]/g;

const isLowerCase = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();

/**
 * Shortens a commit author the way IDEA's ShortNameType does. An `<email>` part is dropped
 * (the email stands in for a missing name), and a bare email's local part is split on
 * delimiters. Names split on spaces, initials also on delimiters, and a first or last name
 * taken from an email is capitalized.
 */
export function shortAuthorName(author: string, names: AnnotateNames): string {
  const raw = author.replace(/\s+/g, " ").trim();
  let name = raw;
  let fromEmail = false;
  const lt = name.indexOf("<");
  const gt = name.indexOf(">");
  const at = name.indexOf("@");
  if (lt >= 0 && lt < at && at < gt) {
    // "Vasya <vasya.pupkin@example.com> Pupkin" → "Vasya Pupkin"
    const email = name.slice(lt + 1, gt).trim();
    const around = [name.slice(0, lt).trim(), name.slice(gt + 1).trim()].filter(Boolean).join(" ");
    fromEmail = !around;
    name = around || email;
  }
  if (names === "fullName") return name;
  const atIndex = name.indexOf("@");
  if (atIndex > 0 && !name.includes(" ")) {
    // "vasya.pupkin@example.com" → "vasya pupkin"
    fromEmail = true;
    name = name.slice(0, atIndex).replace(NAME_DELIMITERS, " ");
  }
  const parts = name.split(" ").filter((p) => p.trim());
  if (!parts.length) return raw;
  if (names === "initials")
    return parts
      .flatMap((p) => p.split(NAME_DELIMITERS))
      .filter((p) => p.trim())
      .map((p) => p[0]!.toUpperCase())
      .join("");
  const picked = names === "firstName" ? parts[0]! : parts[parts.length - 1]!;
  // Emails are usually lowercase while names are capitalized.
  return fromEmail && isLowerCase(picked[0]!) ? picked[0]!.toUpperCase() + picked.slice(1) : picked;
}

/** Hides the columns turned off in Options, here and in editors annotated before the change. */
const annotateColumns = ViewPlugin.define(
  (view) => {
    view.requestMeasure(measureBlameColumns);
    return {
      update(update: ViewUpdate) {
        const before = update.startState.field(blameField, false);
        const after = update.state.field(blameField);
        if (before?.labels !== after.labels || before.current !== after.current)
          view.requestMeasure(measureBlameColumns);
      },
      destroy: useAnnotateColumns.subscribe(() => view.dispatch({})),
    };
  },
  {
    provide: () =>
      EditorView.editorAttributes.of(() => {
        const c = useAnnotateColumns.getState();
        const hidden = COLUMNS.filter((k) => !c[k]);
        return hidden.length ? { class: hidden.map((k) => `cm-vcs-blame-hide-${k}`).join(" ") } : null;
      }),
  },
);

const COLUMN_LABELS: Record<AnnotateColumn, string> = { date: "Date", author: "Author", revision: "Revision" };
const NAME_LABELS: Record<AnnotateNames, string> = {
  initials: "Initials",
  lastName: "Last Name",
  firstName: "First Name",
  fullName: "Full Name",
};
const COLOR_LABELS: Record<AnnotateColors, string> = { author: "Author", order: "Order", hide: "Hide" };

function optionsMenu(): MenuItem {
  const c = useAnnotateColumns.getState();
  const shown = COLUMNS.filter((k) => c[k]).length;
  const { names } = useAnnotateNames.getState();
  const { colors } = useAnnotateColors.getState();
  const { ignoreWhitespace, movement } = workflowSettings().vcs.git.annotate;
  return {
    label: "Options",
    submenu: [
      ...COLUMNS.map((k) => ({
        label: COLUMN_LABELS[k],
        checked: c[k],
        disabled: c[k] && shown === 1,
        run: () => setAnnotateColumn(k, !c[k]),
      })),
      {
        label: "Colors",
        submenu: COLOR_MODES.map((m) => ({
          label: COLOR_LABELS[m],
          checked: colors === m,
          run: () => setAnnotateColors(m),
        })),
      },
      {
        label: "Names",
        submenu: NAME_TYPES.map((t) => ({
          label: NAME_LABELS[t],
          checked: names === t,
          run: () => setAnnotateNames(t),
        })),
      },
      { kind: "separator" },
      {
        label: "Ignore Whitespaces",
        checked: ignoreWhitespace,
        run: () => saveVcsSetting("vcs.git.annotate.ignoreWhitespace", !ignoreWhitespace, "global"),
      },
      {
        label: "Detect Movements Within File",
        checked: movement !== "none",
        run: () => saveVcsSetting("vcs.git.annotate.movement", movement === "none" ? "withinFile" : "none", "global"),
      },
      {
        label: "Detect Movements Across Files",
        checked: movement === "acrossFiles",
        run: () =>
          saveVcsSetting(
            "vcs.git.annotate.movement",
            movement === "acrossFiles" ? "withinFile" : "acrossFiles",
            "global",
          ),
      },
    ],
  };
}

const setBlame = StateEffect.define<BlameLine[]>();
/** The file's current revision (IDEA's FileAnnotation.getCurrentRevision): the last commit to it. */
const setCurrentRevision = StateEffect.define<string | null>();

interface BlameState {
  lines: BlameLine[];
  markers: RangeSet<GutterMarker>;
  labels: Map<string, BlameLabels>;
  current?: string | null;
}

function build(lines: BlameLine[], doc: Text): BlameState {
  const bgs = backgrounds(lines);
  const { names } = useAnnotateNames.getState();
  const labels = new Map<string, BlameLabels>();
  const out = [];
  const n = Math.min(lines.length, doc.lines);
  for (let i = 0; i < n; i++) {
    const line = lines[i]!;
    let label = labels.get(line.commit);
    if (!label && !isUncommitted(line)) {
      label = {
        date: line.timeMs ? formatPrettyDay(line.timeMs) : "",
        author: shortAuthorName(line.author, names),
        revision: line.commit.slice(0, 8),
      };
      labels.set(line.commit, label);
    }
    out.push(new BlameMarker(line, label, bgs.get(line.commit) ?? "").range(doc.line(i + 1).from));
  }
  return { lines, markers: RangeSet.of(out), labels };
}

/** Marks the lines last changed by `current`; the doc may have changed since `st` was built. */
function markCurrent(st: BlameState, current: string | null | undefined): BlameState {
  if (current === undefined) return st;
  const out = [];
  for (const it = st.markers.iter(); it.value; it.next()) {
    const m = it.value as BlameMarker;
    out.push(new BlameMarker(m.line, m.labels, m.bg, m.line.commit === current).range(it.from));
  }
  return { ...st, markers: RangeSet.of(out), current };
}

const blameField = StateField.define<BlameState>({
  create: () => ({ lines: [], markers: RangeSet.empty, labels: new Map() }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlame)) return markCurrent(build(e.value, tr.state.doc), value.current);
      if (e.is(setCurrentRevision)) return markCurrent(value, e.value);
    }
    return tr.docChanged ? { ...value, markers: value.markers.map(tr.changes) } : value;
  },
});

type BlameWidthMeasurement = { gutter: HTMLElement; widths: Record<AnnotateColumn, number> };

/** Use the full file's annotation widths so scrolling does not move the code sideways. */
const measureBlameColumns = {
  read(view: EditorView): BlameWidthMeasurement | null {
    const gutter = view.dom.querySelector<HTMLElement>(".cm-vcs-blame");
    const st = view.state.field(blameField, false);
    const labels = st?.labels;
    if (!gutter || !labels?.size || typeof CanvasRenderingContext2D === "undefined") return null;
    const context = view.dom.ownerDocument.createElement("canvas").getContext("2d");
    if (!context) return null;
    const style = getComputedStyle(gutter);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    const widths = { date: 0, author: 0, revision: 0 };
    for (const column of COLUMNS) {
      for (const label of new Set(Array.from(labels.values(), (entry) => entry[column]))) {
        widths[column] = Math.max(widths[column], context.measureText(label).width);
      }
    }
    // The current revision's labels are bold, so wider.
    const current = st?.current && labels.get(st.current);
    if (current) {
      context.font = `bold ${context.font}`;
      for (const column of COLUMNS)
        widths[column] = Math.max(widths[column], context.measureText(current[column]).width);
    }
    return { gutter, widths };
  },
  write(result: BlameWidthMeasurement | null) {
    if (!result) return;
    const { gutter, widths } = result;
    for (const column of COLUMNS)
      gutter.style.setProperty(`--blame-${column}-width`, `${Math.ceil(widths[column]) + 2}px`);
  },
};

interface BlameSource {
  path: string;
  text?: string;
  revision?: string;
}

class BlameRefresher implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private currentGeneration = 0;
  private readonly off: (() => void)[];
  private readonly live: boolean;

  constructor(
    private readonly view: EditorView,
    private readonly source: BlameSource,
  ) {
    this.live = source.text === undefined && source.revision === undefined;
    this.off = [
      onWorkflowSettingsChange(
        (s) => s.vcs.git.annotate,
        () => this.schedule(0),
      ),
      useAnnotateNames.subscribe(() => this.schedule(0)),
      useAnnotateColors.subscribe(() => this.schedule(0)),
    ];
    if (this.live) {
      this.off.push(
        useVcs.subscribe((s, p) => {
          if (s.branch?.headCommit !== p.branch?.headCommit) {
            this.schedule(100);
            void this.loadCurrentRevision();
          }
        }),
      );
    }
    void this.loadCurrentRevision();
  }

  update(u: ViewUpdate) {
    if (this.live && u.docChanged) this.schedule(800);
  }

  schedule(delay: number) {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    this.timer = setTimeout(() => void this.refresh(generation), delay);
  }

  private async refresh(generation: number) {
    const { path, text, revision } = this.source;
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null)).catch(() => null);
    if (!lines || generation !== this.generation || !annotationsShown(this.view)) return;
    closeBlamePopup(this.view);
    this.view.dispatch({ effects: setBlame.of(lines) });
  }

  /** Loaded after the gutter paints: `git log -1 -- <path>` can take a while in a long history. */
  private async loadCurrentRevision() {
    const generation = ++this.currentGeneration;
    const { path, revision } = this.source;
    // An unset branch would walk every branch, not just HEAD.
    const query = { branch: revision ?? "HEAD", path, author: null, text: null, skip: 0, limit: 1 };
    const [last] = (await call(commands.vcsLog(repoOf(path), query)).catch(() => null)) ?? [];
    if (generation !== this.currentGeneration || !annotationsShown(this.view)) return;
    this.view.dispatch({ effects: setCurrentRevision.of(last?.id ?? null) });
  }

  destroy() {
    ++this.generation;
    ++this.currentGeneration;
    clearTimeout(this.timer);
    for (const off of this.off) off();
  }
}

const blameTheme = EditorView.baseTheme({
  ".cm-vcs-blame": {
    cursor: "pointer",
    borderRight: "1px solid var(--border)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-ui)",
  },
  ".cm-vcs-blame .cm-gutterElement": { padding: "0", display: "flex", alignItems: "stretch" },
  ".cm-vcs-blame-line": {
    flex: "1",
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    padding: "0 var(--space-2) 0 var(--space-1)",
    color: "var(--fg-secondary)",
    whiteSpace: "nowrap",
  },
  // IDEA's Annotations › Last commit colour: bold, brighter than the other annotations.
  ".cm-vcs-blame-line.cm-vcs-blame-current": { color: "var(--git-annotations-last-commit)", fontWeight: "bold" },
  ".cm-vcs-blame-line > span": { flex: "none", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-vcs-blame-date": { width: "min(var(--blame-date-width, 9ch), 14em)" },
  ".cm-vcs-blame-author": { width: "min(var(--blame-author-width, 12ch), 18em)" },
  ".cm-vcs-blame-revision": { width: "var(--blame-revision-width, 9ch)" },
  "&.cm-vcs-blame-hide-date .cm-vcs-blame-date, &.cm-vcs-blame-hide-author .cm-vcs-blame-author, &.cm-vcs-blame-hide-revision .cm-vcs-blame-revision":
    { display: "none" },
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

function blameExtension(lines: BlameLine[], source: BlameSource): Extension {
  const { path } = source;
  const refresher = ViewPlugin.define((view) => new BlameRefresher(view, source));
  return [
    blameField.init((state) => build(lines, state.doc)),
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
            const origin = l?.originPath ?? path;
            event.preventDefault();
            showContextMenu(event as MouseEvent, [
              { label: "Close Annotations", run: () => setAnnotations(view, null, source) },
              ...(l && !isUncommitted(l)
                ? [
                    {
                      label: "Show Diff",
                      icon: "diff",
                      run: () => void import("./annotateRevision").then((m) => m.showRevisionDiff(origin, l.commit)),
                    },
                    {
                      label: "Copy Revision Number",
                      icon: "copy",
                      run: () => void writeClipboardText(l.commit),
                    },
                    { kind: "separator" as const },
                    {
                      label: tx("Annotate at Revision…"),
                      icon: "clock",
                      run: () => void import("./FileRevisionChooser").then((m) => m.annotateFileRevision(path)),
                    },
                    {
                      label: tx("Annotate Revision"),
                      icon: "history",
                      run: () =>
                        void import("./annotateRevision").then((m) =>
                          m.annotateLineRevision(path, l.commit, l.originPath),
                        ),
                    },
                    {
                      label: tx("Annotate Previous Revision"),
                      icon: "history",
                      // Loads the history and diff viewer code only when it is used.
                      run: () =>
                        void import("./annotateRevision").then((m) => m.annotatePreviousRevision(origin, l.commit)),
                    },
                    {
                      label: "Show Commit in Git Log",
                      icon: "commit",
                      run: () => void executeAction("vcs.showCommit", l.commit),
                    },
                    {
                      label: "Ignore This Commit",
                      icon: "hide",
                      run: () => void ignoreCommit(path, l.commit, () => view.plugin(refresher)?.schedule(0)),
                    },
                  ]
                : []),
              optionsMenu(),
            ]);
            return true;
          },
        },
      }),
    ),
    ViewPlugin.define((view) => new BlameInteraction(view)),
    annotateColumns,
    refresher,
    blameTheme,
  ];
}

export function annotationsShown(view: EditorView): boolean {
  return !!view.state.field(blameField, false);
}

function setAnnotations(view: EditorView, lines: BlameLine[] | null, source: BlameSource) {
  if (!lines) closeBlamePopup(view);
  view.dispatch({ effects: blameCompartment.reconfigure(lines ? blameExtension(lines, source) : []) });
}

/**
 * Appends `commit` to the repository's ignore list so annotate skips it, then re-blames
 * the gutter.
 */
async function ignoreCommit(path: string, commit: string, refresh: () => void) {
  try {
    await call(commands.vcsIgnoreBlameRevision(path, commit));
    refresh();
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot ignore the commit",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Toggles annotations in `view`; `text` blames that content instead of the file on
 * disk, `revision` the history it is blamed on (default HEAD). */
export async function toggleAnnotations(view: EditorView, path: string, text?: string, revision?: string) {
  if (annotationsShown(view)) {
    setAnnotations(view, null, { path });
    return;
  }
  try {
    const lines = await call(commands.vcsBlame(path, text ?? null, revision ?? null));
    // A file Git has no commit of (unversioned, ignored, added) would get an empty column.
    if (revision === undefined && lines.every(isUncommitted)) {
      notifications().notify({
        group: "vcs",
        level: "info",
        title: "Nothing to annotate",
        body: "The file has no committed history in Git.",
      });
      return;
    }
    setAnnotations(view, lines, { path, text, revision });
  } catch (e) {
    notifications().notify({
      group: "vcs",
      level: "error",
      title: "Cannot annotate",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}
