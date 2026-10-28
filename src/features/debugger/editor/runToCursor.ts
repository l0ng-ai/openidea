/**
 * Inlay Run to Cursor: while the debugger is paused, hovering the start of a
 * line shows a small button left of its text that runs to that line (Resume on
 * the execution line itself). Settings › Debugger › "Show inlay Run to Cursor popup".
 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { iconNode } from "@/editor/lsp/iconMarkup";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { workflowSettings } from "@/platform/workflowSettings";
import { runToLine } from "../actions";
import { activeSession, useExecutionPoint } from "../state";
import styles from "./editor.module.css";

/** Hover area from the left edge of the text, in characters. */
const HOVER_CHARS = 4;
const BUTTON = 20;

/** The 0-based line whose start the pointer is over, or null. */
export function hoveredLine(
  textLeft: number,
  charWidth: number,
  x: number,
  line: { number: number; text: string },
): number | null {
  if (x < textLeft || x - textLeft > charWidth * HOVER_CHARS) return null;
  return line.text.trim() ? line.number - 1 : null;
}

export function runToCursorInlay(ctx: EditorDocContext): Extension {
  if (ctx.virtual) return [];
  const path = ctx.path;
  return ViewPlugin.fromClass(
    class {
      private button: HTMLButtonElement | null = null;
      private line = -1;
      private unsub: () => void;
      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("mousemove", this.onMove);
        view.scrollDOM.addEventListener("mouseleave", this.onLeave);
        view.scrollDOM.addEventListener("scroll", this.hide);
        // Resumed / stopped / moved: the button's action may no longer apply.
        this.unsub = useExecutionPoint.subscribe(this.hide);
      }

      private enabled() {
        return workflowSettings().debugger.runToCursorInlay && activeSession()?.status === "paused";
      }

      private onMove = (e: MouseEvent) => {
        if (e.target instanceof Node && this.button?.contains(e.target)) return;
        if (!this.enabled() || e.buttons) return this.hide();
        const { view } = this;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        const block = view.lineBlockAtHeight(e.clientY - view.documentTop);
        if (pos == null || pos < block.from || pos > block.to) return this.hide();
        const line = view.state.doc.lineAt(block.from);
        const textLeft = view.coordsAtPos(line.from, 1)?.left;
        if (textLeft == null) return this.hide();
        const target = hoveredLine(textLeft, view.defaultCharacterWidth, e.clientX, line);
        if (target == null) return this.hide();
        if (target !== this.line) this.show(target, block.top + view.documentTop, line.from);
      };

      private onLeave = (e: MouseEvent) => {
        if (!(e.relatedTarget instanceof Node && this.button?.contains(e.relatedTarget))) this.hide();
      };

      private show(line: number, top: number, lineFrom: number) {
        this.hide();
        const { view } = this;
        const exec = useExecutionPoint.getState();
        const atExecution = exec.path === path && exec.line === line;
        const label = atExecution ? tx("Resume Program") : tx("Run to Cursor");
        const b = document.createElement("button");
        b.type = "button";
        b.className = styles.runToCursor!;
        b.title = label;
        b.setAttribute("aria-label", label);
        b.append(iconNode(atExecution ? "resume" : "run-to-cursor", 14));
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", (e) => {
          e.preventDefault();
          this.hide();
          if (atExecution) executeAction("debug.resume");
          else runToLine(path, line);
        });
        b.addEventListener("mouseleave", (e) => {
          if (!(e.relatedTarget instanceof Node && view.scrollDOM.contains(e.relatedTarget))) this.hide();
        });
        // Left of the first non-space character; over the gutter edge when the indent is too narrow.
        const text = view.state.doc.lineAt(lineFrom).text;
        const indentEnd = lineFrom + (text.length - text.trimStart().length);
        const textX = view.coordsAtPos(indentEnd)?.left ?? view.contentDOM.getBoundingClientRect().left;
        const host = view.dom.getBoundingClientRect();
        const lineHeight = view.lineBlockAt(lineFrom).height;
        b.style.left = `${textX - host.left - BUTTON - 2}px`;
        b.style.top = `${top - host.top + (lineHeight - BUTTON) / 2}px`;
        view.dom.appendChild(b);
        this.button = b;
        this.line = line;
      }

      hide = () => {
        this.button?.remove();
        this.button = null;
        this.line = -1;
      };

      destroy() {
        this.hide();
        this.unsub();
        this.view.scrollDOM.removeEventListener("mousemove", this.onMove);
        this.view.scrollDOM.removeEventListener("mouseleave", this.onLeave);
        this.view.scrollDOM.removeEventListener("scroll", this.hide);
      }
    },
  );
}
