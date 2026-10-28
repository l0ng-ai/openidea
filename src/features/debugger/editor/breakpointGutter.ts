/**
 * Breakpoints in the editor: markers on the line-number gutter (classes only,
 * so the number keeps rendering; the dot is a pseudo-element), click to
 * toggle, right-click for the properties popover, and line tracking through edits.
 */
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, lineNumberMarkers, type ViewUpdate } from "@codemirror/view";
import { editorsFor, mirroredChange, remoteChange, useEditorRegistry, type EditorDocContext } from "@/editor/api";
import { isConditional, mapLines, suspends, type BreakpointEntry, type BreakpointStatus } from "../breakpoints/model";
import {
  addBreakpoint,
  breakpointsOf,
  removeBreakpoint,
  setFileBreakpoints,
  updateBreakpoint,
  useBreakpoints,
} from "../breakpoints/store";
import { canPlaceBreakpoint } from "../breakpoints/languages";
import {
  removeSpecial,
  setSpecialLines,
  specialAt,
  updateSpecial,
  useSpecialBreakpoints,
  type SpecialBreakpoint,
} from "../breakpoints/special";
import { toggleBreakpointSmart } from "../breakpoints/toggle";
import { sessionsRunning, useDebug } from "../state";
import { openBreakpointPopover } from "../ui/popoverStore";
import styles from "./editor.module.css";

export type BreakpointLook =
  | "normal"
  | "disabled"
  | "unverified"
  | "verified"
  | "conditional"
  | "log"
  | "method"
  | "methodDisabled"
  | "methodVerified"
  | "field"
  | "fieldDisabled"
  | "fieldVerified";

export function lookOf(b: BreakpointEntry, status: BreakpointStatus | undefined, muted: boolean, running: boolean) {
  if (!b.enabled || muted) return "disabled";
  if (running && status && !status.verified) return "unverified";
  if (!suspends(b)) return "log";
  if (isConditional(b)) return "conditional";
  return running && status?.verified ? "verified" : "normal";
}

/** Method breakpoints / field watchpoints use IDEA's expui icons. */
export function specialLook(
  b: SpecialBreakpoint,
  status: BreakpointStatus | undefined,
  muted: boolean,
  running: boolean,
): BreakpointLook {
  if (!b.enabled || muted) return b.kind === "method" ? "methodDisabled" : "fieldDisabled";
  if (running && status && !status.verified) return "unverified";
  if (running && status?.verified) return b.kind === "method" ? "methodVerified" : "fieldVerified";
  return b.kind;
}

class BreakpointMarker extends GutterMarker {
  constructor(
    readonly id: string,
    readonly look: BreakpointLook,
  ) {
    super();
    this.elementClass = `${styles.bp} ${styles[look] ?? ""}`;
  }
  eq(other: BreakpointMarker) {
    return other.id === this.id && other.look === this.look;
  }
}

const bpLine = Decoration.line({ class: styles.bpLine });
const DISABLED_LOOKS = new Set<BreakpointLook>(["disabled", "methodDisabled", "fieldDisabled"]);

const setMarkers = StateEffect.define<RangeSet<BreakpointMarker>>();

function buildMarkers(state: EditorState, path: string): RangeSet<BreakpointMarker> {
  const { status, muted } = useBreakpoints.getState();
  const running = sessionsRunning();
  const doc = state.doc;
  const special = specialAt(path).filter((b) => b.line! < doc.lines);
  const specialStatus = useSpecialBreakpoints.getState().status;
  const taken = new Set(special.map((b) => b.line));
  const ranges = [
    ...special.map((b) =>
      new BreakpointMarker(b.id, specialLook(b, specialStatus[b.id], muted, running)).range(doc.line(b.line! + 1).from),
    ),
    ...breakpointsOf(path)
      .filter((b) => b.line < doc.lines && !taken.has(b.line))
      .map((b) => new BreakpointMarker(b.id, lookOf(b, status[b.id], muted, running)).range(doc.line(b.line + 1).from)),
  ];
  return RangeSet.of(ranges, true);
}

/** For backend patches applied to every pane: the one editor of `path` that moves the stored lines. */
function isWriter(view: EditorView, path: string): boolean {
  const editors = editorsFor(path);
  if (editors.length <= 1) return true;
  const active = useEditorRegistry.getState().active;
  const writer = editors.find((e) => e === active) ?? editors[0];
  return writer?.view === view;
}

function lineAtEvent(view: EditorView, e: MouseEvent): number | null {
  const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
  if (!block) return null;
  return view.state.doc.lineAt(block.from).number - 1;
}

/**
 * Like IDEA, the whole gutter left of the fold column toggles breakpoints:
 * line numbers plus the empty space of the other gutters (their own markers,
 * e.g. run icons or change bars, keep their clicks).
 */
function inBreakpointArea(e: MouseEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t?.closest?.(".cm-gutters") || t.closest(".cm-foldGutter, .cm-vcs-blame")) return false;
  if (t.closest(".cm-lineNumbers")) return true;
  if (t.classList.contains("cm-gutter")) return true;
  return t.classList.contains("cm-gutterElement") && t.childElementCount === 0;
}

export function breakpointGutter(ctx: EditorDocContext): Extension {
  const path = ctx.path;
  const field = StateField.define<RangeSet<BreakpointMarker>>({
    create: (state) => buildMarkers(state, path),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
      return tr.docChanged ? value.map(tr.changes) : value;
    },
    provide: (f) => [
      lineNumberMarkers.from(f),
      // IDEA tints the whole line of an active breakpoint.
      EditorView.decorations.from(f, (markers) => {
        const lines: Array<ReturnType<Decoration["range"]>> = [];
        for (const it = markers.iter(); it.value; it.next())
          if (!DISABLED_LOOKS.has(it.value.look)) lines.push(bpLine.range(it.from));
        return Decoration.set(lines);
      }),
    ],
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private unsubs: Array<() => void>;
      private pending = false;
      private destroyed = false;
      constructor(readonly view: EditorView) {
        this.unsubs = [
          useBreakpoints.subscribe((s, prev) => {
            if (s.byFile[path] !== prev.byFile[path] || s.status !== prev.status || s.muted !== prev.muted)
              this.scheduleRebuild();
          }),
          useDebug.subscribe((s, prev) => {
            if (s.sessions !== prev.sessions) this.scheduleRebuild();
          }),
          useSpecialBreakpoints.subscribe((s, prev) => {
            if (s.methods !== prev.methods || s.fields !== prev.fields || s.status !== prev.status)
              this.scheduleRebuild();
          }),
        ];
        view.dom.addEventListener("mousedown", this.onMouseDown);
        // Inside view.dom, so this runs before the editor's gutter menu listener there.
        view.scrollDOM.addEventListener("contextmenu", this.onContextMenu);
      }

      scheduleRebuild() {
        if (this.pending) return;
        this.pending = true;
        queueMicrotask(() => {
          this.pending = false;
          if (this.destroyed) return;
          const next = buildMarkers(this.view.state, path);
          const cur = this.view.state.field(field);
          if (!RangeSet.eq([cur], [next])) this.view.dispatch({ effects: setMarkers.of(next) });
        });
      }

      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        // Split panes mirror one document: only the originating view moves the stored lines.
        const mirrored = u.transactions.some((tr) => tr.annotation(mirroredChange));
        const remote = u.transactions.some((tr) => tr.annotation(remoteChange));
        if (!mirrored && (!remote || isWriter(u.view, path))) {
          const list = breakpointsOf(path);
          if (list.length) setFileBreakpoints(path, mapLines(list, u.startState.doc, u.changes, u.state.doc));
          const special = specialAt(path).map((b) => ({ id: b.id, line: b.line! }));
          if (special.length) setSpecialLines(path, mapLines(special, u.startState.doc, u.changes, u.state.doc));
        } else {
          this.scheduleRebuild();
        }
      }

      /**
       * IDEA's gutter clicks: click toggles; on an empty line ⇧-click adds a non-suspending
       * logging breakpoint and opens its properties, ⌥-click a temporary one. On an existing
       * breakpoint only a plain (or ⌘/Ctrl) click removes it; middle-click enables/disables.
       */
      onMouseDown = (e: MouseEvent) => {
        if ((e.button !== 0 && e.button !== 1) || !inBreakpointArea(e)) return;
        const line = lineAtEvent(this.view, e);
        if (line == null) return;
        const special = specialAt(path).find((b) => b.line === line);
        const bp = breakpointsOf(path).find((b) => b.line === line);
        if (e.button === 1) {
          if (!special && !bp) return;
          e.preventDefault();
          if (special) updateSpecial(special.id, { enabled: !special.enabled });
          else if (bp) updateBreakpoint(path, bp.id, { enabled: !bp.enabled });
          return;
        }
        if (!canPlaceBreakpoint(ctx.language) && !bp) return;
        e.preventDefault();
        // Acts on release over the same line: a drag across the gutter selects lines instead.
        const up = (u: MouseEvent) => {
          window.removeEventListener("mouseup", up, true);
          if (u.button === 0 && lineAtEvent(this.view, u) === line) this.onClick(e, line, special, bp);
        };
        window.addEventListener("mouseup", up, true);
      };

      onClick = (
        e: MouseEvent,
        line: number,
        special: ReturnType<typeof specialAt>[number] | undefined,
        bp: ReturnType<typeof breakpointsOf>[number] | undefined,
      ) => {
        if (special || bp) {
          if (e.shiftKey || e.altKey) return;
          if (special) removeSpecial(special.id);
          else removeBreakpoint(path, bp!.id);
          return;
        }
        if (e.altKey) {
          addBreakpoint(path, line, { temporary: true });
          return;
        }
        if (e.shiftKey) {
          const created = addBreakpoint(path, line, { suspend: false, logHit: true });
          openBreakpointPopover(path, created.id, { x: e.clientX, y: e.clientY });
          return;
        }
        toggleBreakpointSmart(path, line, ctx.language, this.view.state.doc.toString());
      };

      onContextMenu = (e: MouseEvent) => {
        if (!inBreakpointArea(e)) return;
        const line = lineAtEvent(this.view, e);
        if (line == null) return;
        // Other lines get the editor's gutter menu, like IDEA.
        const bp = specialAt(path).find((b) => b.line === line) ?? breakpointsOf(path).find((b) => b.line === line);
        if (!bp) return;
        e.preventDefault();
        openBreakpointPopover(path, bp.id, { x: e.clientX, y: e.clientY });
      };

      destroy() {
        this.destroyed = true;
        this.unsubs.forEach((u) => u());
        this.view.dom.removeEventListener("mousedown", this.onMouseDown);
        this.view.scrollDOM.removeEventListener("contextmenu", this.onContextMenu);
      }
    },
  );

  return [
    field,
    plugin,
    EditorView.theme({
      ".cm-lineNumbers .cm-gutterElement": { cursor: "default" },
    }),
  ];
}
