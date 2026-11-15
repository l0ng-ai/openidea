import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { BlameLine } from "@/bindings";
import { HEAVY_LIMIT, onEditorEvent, type EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx, useI18n } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { onWorkflowSettingsChange, workflowSettings } from "@/platform/workflowSettings";
import { isUncommitted } from "./blame";
import { repoOf, statusOf, useVcs } from "./store";

export function relativeBlameDate(timeMs: number | null, now = Date.now()): string {
  if (timeMs === null) return "";
  const seconds = Math.max(0, (now - timeMs) / 1000);
  const units = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const;
  const unit = units.find(([, size]) => seconds >= size);
  return unit
    ? new Intl.RelativeTimeFormat(useI18n.getState().locale, { numeric: "always" }).format(
        -Math.floor(seconds / unit[1]),
        unit[0],
      )
    : tx("now");
}

export function formatInlineBlame(line: BlameLine, now = Date.now()): string {
  if (isUncommitted(line)) return tx("You, now · Uncommitted changes");
  const date = relativeBlameDate(line.timeMs, now);
  return `${line.author}${date ? `, ${date}` : ""} · ${line.summary.replace(/\s+/g, " ")}`;
}

/** The four segments Color Scheme › Git › Editor inline blame styles. */
interface BlameSegment {
  text: string;
  key: "author" | "date" | "subject" | "issue";
}

/** Splits the blame text so each part can use its own Git scheme colour. */
export function inlineBlameSegments(line: BlameLine, now = Date.now()): BlameSegment[] {
  if (isUncommitted(line)) return [{ text: formatInlineBlame(line, now), key: "subject" }];
  const date = relativeBlameDate(line.timeMs, now);
  const summary = line.summary.replace(/\s+/g, " ");
  const author = line.author;
  // A trailing (#123) / #ISSUE-1 reference is the issue link, coloured separately.
  const issue = /\s(\(#[^)]+\)|#[\w-]+)\s*$/.exec(summary);
  const subject = issue ? summary.slice(0, issue.index) : summary;
  return [
    { text: date ? `${author}, ` : `${author} · `, key: "author" },
    ...(date ? [{ text: `${date} · `, key: "date" } as BlameSegment] : []),
    { text: subject, key: "subject" },
    ...(issue ? [{ text: summary.slice(issue.index), key: "issue" } as BlameSegment] : []),
  ];
}

/** Only the current document version is retained, including its in-flight request. */
class BlameCache {
  private doc: Text | undefined;
  private pending: Promise<BlameLine[]> | undefined;
  private lines: BlameLine[] | undefined;

  clear() {
    this.doc = undefined;
    this.pending = undefined;
    this.lines = undefined;
  }

  get(doc: Text, load: () => Promise<BlameLine[]>): Promise<BlameLine[]> {
    if (doc !== this.doc || !this.pending) {
      this.doc = doc;
      this.lines = undefined;
      this.pending = load().then((lines) => {
        if (this.doc === doc) this.lines = lines;
        return lines;
      });
    }
    return this.pending;
  }

  /** The resolved blame for `doc`, when it is already loaded. */
  peek(doc: Text): BlameLine[] | undefined {
    return doc === this.doc ? this.lines : undefined;
  }
}

/** An element's own custom property in px (its anchor offset), or 0. Inherited custom
    properties resolve through the cascade, so reading the inner box finds the anchor's. */
function offsetOf(el: HTMLElement, property: string): number {
  return Number.parseFloat(getComputedStyle(el).getPropertyValue(property)) || 0;
}

class BlameWidget extends WidgetType {
  /** Last offset applied, so the observer does not rewrite the style on every keystroke. */
  private appliedWidth = -1;
  private observer: MutationObserver | undefined;

  constructor(
    readonly line: BlameLine,
    /** The annotated line has no text: no gap before the label, or the caret would look indented. */
    readonly blank: boolean,
  ) {
    super();
  }

  eq(other: BlameWidget) {
    return (
      this.blank === other.blank &&
      formatInlineBlame(other.line) === formatInlineBlame(this.line) &&
      other.line.commit === this.line.commit
    );
  }

  /**
   * Line-end annotations stack left to right: the code-vision hint, every plugin's line-end
   * message, then this label. The hint is out of flow (see codeLens.ts) and each message steps
   * past its predecessors itself, so this one steps past the whole chain, as IDEA lays its
   * line-end inlays out. They can also appear (or go away) after this widget mounted, hence the
   * observer below.
   */
  private stepPastLineEnd(el: HTMLElement) {
    const line = el.closest(".cm-line");
    if (!line) return;
    let width = 0;
    const hint = line.querySelector<HTMLElement>(".cm-openidea-lensInlineInner");
    // The hint's inner box sits its anchor's `--openidea-hint-offset` past that anchor.
    if (hint) width += Math.round(hint.getBoundingClientRect().width) + offsetOf(hint, "--openidea-hint-offset");
    // Plugin messages are zero-width anchors; their inner boxes carry the visible width and
    // inherit the anchor's `--openidea-message-offset`.
    for (const anchor of line.querySelectorAll<HTMLElement>(".cm-plugin-after")) {
      const box = anchor.firstElementChild as HTMLElement | null;
      if (box) width += Math.round(box.getBoundingClientRect().width) + offsetOf(box, "--openidea-message-offset");
    }
    if (width === this.appliedWidth) return;
    this.appliedWidth = width;
    // Padding, not margin: the gap is virtual (it only moves the label), so the caret at the
    // line end stays next to the code. A blank line has no code to separate from: no gap.
    el.style.paddingLeft = this.blank ? "0" : width ? `calc(3ch + ${width}px)` : "";
    // The label's box spans the virtual gap, but only its text is the blame: clip the hover and
    // click region to the text so a pointer over the gap (where the lens message sits) does not
    // open the commit tooltip.
    el.style.clipPath = width ? `inset(0 0 0 ${width}px)` : "";
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = this.blank ? "cm-vcs-inline-blame cm-vcs-inline-blame-blank" : "cm-vcs-inline-blame";
    for (const segment of inlineBlameSegments(this.line)) {
      const part = document.createElement("span");
      part.className = `cm-vcs-inline-blame-${segment.key}`;
      part.textContent = segment.text;
      el.append(part);
    }
    el.contentEditable = "false";
    // The element is only measurable once CodeMirror has inserted it: defer to the next task, not a
    // nested frame, so a widget that goes away first simply skips.
    setTimeout(() => {
      if (!el.isConnected) return;
      this.stepPastLineEnd(el);
      const line = el.closest(".cm-line");
      if (!line) return;
      this.observer = new MutationObserver(() => this.stepPastLineEnd(el));
      this.observer.observe(line, { childList: true, subtree: true, characterData: true });
    }, 0);
    if (!isUncommitted(this.line)) {
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const open = () => void executeAction("vcs.showCommit", this.line.commit);
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    }
    return el;
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

const setInlineBlame = StateEffect.define<DecorationSet>();
const inlineBlameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged || tr.selection) return Decoration.none;
    for (const effect of tr.effects) if (effect.is(setInlineBlame)) return effect.value;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function inlineBlame(ctx: EditorDocContext): Extension {
  if (ctx.virtual || ctx.readOnly) return [];
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private readonly cache = new BlameCache();
      private readonly messages = new Map<string, Promise<string>>();
      private readonly off: (() => void)[];
      private generation = 0;
      private destroyed = false;
      /** The element the pointer last moved over; the hover belongs to the label alone. */
      hoverTarget: EventTarget | null = null;
      line: BlameLine | undefined;

      constructor(readonly view: EditorView) {
        // Record the real pointer target: CodeMirror resolves a hover over any line-end
        // widget (a plugin lens, a code-vision hint) to the same offset as the blame, so
        // position alone cannot tell the label apart from its neighbours.
        const onMove = (e: MouseEvent) => {
          this.hoverTarget = e.target;
        };
        view.dom.addEventListener("mousemove", onMove);
        this.off = [
          () => view.dom.removeEventListener("mousemove", onMove),
          useVcs.subscribe((s, prev) => {
            if (s.version !== prev.version) this.invalidate();
          }),
          onEditorEvent((e) => {
            if (e.type === "docSaved" && e.path === ctx.path) this.invalidate();
          }),
          onWorkflowSettingsChange(
            (s) => s.vcs.git.inlineBlame,
            () => this.invalidate(),
          ),
          useI18n.subscribe(() => this.invalidate()),
        ];
        this.schedule();
      }

      private enabled() {
        const vcs = useVcs.getState();
        const status = statusOf(ctx.path);
        return (
          workflowSettings().vcs.git.inlineBlame &&
          isTauri() &&
          vcs.available &&
          vcs.statusLoaded &&
          !!repoOf(ctx.path) &&
          status?.unstaged !== "untracked" &&
          status?.unstaged !== "ignored" &&
          this.view.state.doc.length <= HEAVY_LIMIT
        );
      }

      private clear() {
        this.line = undefined;
        if (this.view.state.field(inlineBlameField).size)
          this.view.dispatch({ effects: setInlineBlame.of(Decoration.none) });
      }

      private invalidate() {
        this.cache.clear();
        this.clear();
        this.schedule();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.cache.clear();
        if (update.docChanged || update.selectionSet) {
          this.line = undefined;
          // A caret move in a document whose blame is already loaded needs no git
          // call, so show it without the debounce that protects that call (#3396).
          if (!update.docChanged && this.cache.peek(update.state.doc) !== undefined) {
            clearTimeout(this.timer);
            ++this.generation;
            void this.refresh();
          } else {
            this.schedule();
          }
        }
      }

      private schedule() {
        clearTimeout(this.timer);
        ++this.generation;
        this.timer = setTimeout(() => void this.refresh(), 300);
      }

      private async refresh() {
        if (this.destroyed || !this.enabled()) return;
        const { doc, selection } = this.view.state;
        const caret = doc.lineAt(selection.main.head);
        if (doc.lineAt(selection.main.from).number !== doc.lineAt(selection.main.to).number) return;
        const generation = this.generation;
        try {
          const lines = await this.cache.get(doc, async () => {
            // Blame also returns synthetic entries for paths absent from HEAD (ignored / new files).
            if ((await call(commands.vcsFileAt(ctx.path, "HEAD"))) === null) return [];
            return call(commands.vcsBlame(ctx.path, doc.toString(), null));
          });
          if (this.destroyed || generation !== this.generation || doc !== this.view.state.doc || !this.enabled())
            return;
          this.line = lines[caret.number - 1];
          if (this.line) {
            const widget = Decoration.widget({
              widget: new BlameWidget(this.line, caret.text.trim().length === 0),
              // After a plugin's line-end message (side 1): git hint | lens | blame.
              side: 2,
            }).range(caret.to);
            this.view.dispatch({ effects: setInlineBlame.of(Decoration.set([widget])) });
          }
        } catch {
          // Repository removed, unborn HEAD, inaccessible file, etc.: leave the line undecorated.
        }
      }

      message(line: BlameLine): Promise<string> {
        if (isUncommitted(line)) return Promise.resolve(tx("You, now · Uncommitted changes"));
        let message = this.messages.get(line.commit);
        if (!message) {
          message = call(
            commands.vcsLog(repoOf(ctx.path), {
              branch: line.commit,
              path: null,
              author: null,
              text: null,
              skip: 0,
              limit: 1,
            }),
          ).then(
            (commits) => commits[0]?.message ?? line.summary,
            () => line.summary,
          );
          if (this.messages.size >= 100) this.messages.delete(this.messages.keys().next().value!);
          this.messages.set(line.commit, message);
        }
        return message;
      }

      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.cache.clear();
        this.off.forEach((off) => off());
      }
    },
  );
  return [
    inlineBlameField,
    plugin,
    hoverTooltip(
      async (view, pos, side) => {
        const instance = view.plugin(plugin);
        const line = instance?.line;
        const end = view.state.doc.lineAt(view.state.selection.main.head).to;
        if (!instance || !line || pos !== end || side < 0) return null;
        // The lens and other line-end widgets share the blame's offset, so a hover over
        // them resolves here too; only the label itself opens the commit tooltip.
        const target = instance.hoverTarget;
        if (!(target instanceof Element) || !target.closest(".cm-vcs-inline-blame")) return null;
        const message = await instance.message(line);
        if (view.plugin(plugin)?.line !== line) return null;
        return {
          pos: end,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-vcs-inline-blame-tooltip";
            dom.textContent = isUncommitted(line)
              ? message
              : `${line.author}\n${line.timeMs === null ? "" : new Date(line.timeMs).toLocaleString()}\n${line.commit}\n\n${message}`;
            return { dom };
          },
        };
      },
      {
        hideOnChange: true,
        hideOn: (tr) => tr.effects.some((effect) => effect.is(setInlineBlame)),
      },
    ),
    EditorView.baseTheme({
      ".cm-vcs-inline-blame": {
        paddingLeft: "3ch",
        display: "inline-block",
        whiteSpace: "nowrap",
        verticalAlign: "bottom",
        userSelect: "none",
      },
      ".cm-vcs-inline-blame-author": {
        color: "var(--git-blame-author, var(--fg-inlay))",
        backgroundColor: "var(--git-blame-author-bg, transparent)",
        fontWeight: "var(--git-blame-author-bold, inherit)",
        fontStyle: "var(--git-blame-author-italic, inherit)",
        textDecoration: "var(--git-blame-author-effect, none)",
      },
      ".cm-vcs-inline-blame-date": {
        color: "var(--git-blame-date, var(--fg-inlay))",
        backgroundColor: "var(--git-blame-date-bg, transparent)",
        fontWeight: "var(--git-blame-date-bold, inherit)",
        fontStyle: "var(--git-blame-date-italic, inherit)",
        textDecoration: "var(--git-blame-date-effect, none)",
      },
      ".cm-vcs-inline-blame-subject": {
        color: "var(--git-blame-subject, var(--fg-inlay))",
        backgroundColor: "var(--git-blame-subject-bg, transparent)",
        fontWeight: "var(--git-blame-subject-bold, inherit)",
        fontStyle: "var(--git-blame-subject-italic, inherit)",
        textDecoration: "var(--git-blame-subject-effect, none)",
      },
      ".cm-vcs-inline-blame-issue": {
        color: "var(--git-blame-issue, var(--fg-inlay))",
        backgroundColor: "var(--git-blame-issue-bg, transparent)",
        fontWeight: "var(--git-blame-issue-bold, inherit)",
        fontStyle: "var(--git-blame-issue-italic, inherit)",
        textDecoration: "var(--git-blame-issue-effect, none)",
      },
      // An empty line has no code to separate from: the label sits at the line start, so the
      // caret stays at column 0 instead of jumping past the gap.
      ".cm-vcs-inline-blame-blank": { paddingLeft: "0" },
      '.cm-vcs-inline-blame[role="button"]': { cursor: "pointer" },
      ".cm-vcs-inline-blame-tooltip": {
        padding: "8px 12px",
        maxWidth: "min(70ch, 80vw)",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
    }),
  ];
}
