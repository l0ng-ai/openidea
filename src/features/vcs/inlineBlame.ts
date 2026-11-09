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

/** Only the current document version is retained, including its in-flight request. */
class BlameCache {
  private doc: Text | undefined;
  private pending: Promise<BlameLine[]> | undefined;

  clear() {
    this.doc = undefined;
    this.pending = undefined;
  }

  get(doc: Text, load: () => Promise<BlameLine[]>): Promise<BlameLine[]> {
    if (doc !== this.doc || !this.pending) {
      this.doc = doc;
      this.pending = load();
    }
    return this.pending;
  }
}

class BlameWidget extends WidgetType {
  constructor(readonly line: BlameLine) {
    super();
  }

  eq(other: BlameWidget) {
    return formatInlineBlame(other.line) === formatInlineBlame(this.line) && other.line.commit === this.line.commit;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-vcs-inline-blame";
    el.textContent = formatInlineBlame(this.line);
    el.contentEditable = "false";
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
      line: BlameLine | undefined;

      constructor(readonly view: EditorView) {
        this.off = [
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
          this.schedule();
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
            const widget = Decoration.widget({ widget: new BlameWidget(this.line), side: 1 }).range(caret.to);
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
        color: "var(--fg-inlay)",
        marginLeft: "3ch",
        display: "inline-block",
        maxWidth: "min(60ch, 50vw)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "bottom",
        userSelect: "none",
      },
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
