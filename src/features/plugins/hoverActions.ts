/**
 * Hover-revealed inline editor actions (API 1.14).
 *
 * The host decides which action matches a line. This layer implements the
 * editor-local parts of the interaction:
 * - only the leftmost editing-area strip of a line is a trigger;
 * - leaving the editing area to the left keeps the action visible;
 * - entering the editing area to the right of the strip hides it;
 * - the action is anchored to the action's `line`, not the hovered
 *   line, so hovering a method body shows the button at its declaration.
 */
import type { EditorView } from "@codemirror/view";

import { call, commands, type HoverAction } from "@/platform/ipc";
import type { EditorDocContext } from "@/editor/api";
import { markerIcon } from "./lineMarkerGutter";
import { gutterIconMarkup } from "@/ui/icons";
import { setHoverActions } from "@/platform/hoverActions";
import { tx } from "@/platform/i18n";
import { showContextMenu } from "@/ui";
import styles from "./HoverActions.module.css";

export type PlacedHoverAction = { plugin: string; action: HoverAction };

/** Host-owned approximate width of the narrow left trigger strip, in character
 * widths. The exact width belongs to the host; the reference is about four
 * characters and adapts to the editor's font and zoom. */
export const HOST_TRIGGER_STRIP_CHARS = 4;

/** Whether a line belongs to an action's trigger range. */
export function matchesLine(action: HoverAction, line: number): boolean {
  return action.startLine <= line && line <= action.endLine;
}

/** The innermost matching action wins, as when finding the innermost method. */
export function matchingActions(actions: readonly PlacedHoverAction[], line: number): PlacedHoverAction[] {
  const matches = actions.filter(({ action }) => matchesLine(action, line));
  if (!matches.length) return [];
  const span = ({ action }: PlacedHoverAction) => action.endLine - action.startLine;
  const smallest = Math.min(...matches.map(span));
  return matches.filter((match) => span(match) === smallest);
}

class HoverActionLayer {
  private readonly root: HTMLDivElement;
  private placed: PlacedHoverAction[] = [];
  private shown: PlacedHoverAction[] = [];
  private visible = false;
  private readonly onMove = (event: MouseEvent) => this.handleMove(event);
  private readonly onScroll = () => this.reposition();
  private readonly onResize = () => this.reposition();
  private readonly onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Node && this.root.contains(event.target)) this.setVisible(true);
  };
  private readonly onWindowBlur = () => this.forceHide();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden") this.forceHide();
  };
  private readonly onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (this.root.contains(next) || this.view.dom.contains(next))) return;
    this.forceHide();
  };

  constructor(
    private readonly view: EditorView,
    private readonly ctx: EditorDocContext,
  ) {
    this.root = document.createElement("div");
    this.root.className = `${styles.layer} cm-plugin-hover-actions`;
    this.root.dataset.visible = "false";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", tx`Hover actions`);
    view.dom.appendChild(this.root);
    view.contentDOM.addEventListener("mousemove", this.onMove);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    this.root.addEventListener("focusin", this.onFocusIn);
    this.view.dom.addEventListener("focusout", this.onFocusOut);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  set(actions: readonly PlacedHoverAction[]) {
    const next = [...actions];
    const signature = next
      .map(({ plugin, action }) => `${plugin}:${action.command}:${action.line}:${action.label}`)
      .join("|");
    if (
      signature ===
      this.placed.map(({ plugin, action }) => `${plugin}:${action.command}:${action.line}:${action.label}`).join("|")
    ) {
      this.placed = next;
      setHoverActions(this.ctx.doc, next);
      return;
    }
    // A provider refresh must not yank the action out from under keyboard focus.
    if (this.root.contains(document.activeElement)) {
      this.placed = next;
      setHoverActions(this.ctx.doc, next);
      return;
    }
    this.placed = next;
    setHoverActions(this.ctx.doc, next);
    this.clear();
  }

  private stripWidth(): number {
    const width = (this.view as EditorView & { defaultCharacterWidth?: number }).defaultCharacterWidth ?? 8;
    return width * HOST_TRIGGER_STRIP_CHARS;
  }

  /** Keep the host intention bulb out of this anchor line's rail. */
  private reserveLine(line: number | null) {
    const scroll = this.view.scrollDOM;
    const next = line == null ? "" : String(line + 1);
    if ((scroll.dataset.hoverActionLine ?? "") === next) return;
    if (line == null) delete scroll.dataset.hoverActionLine;
    else scroll.dataset.hoverActionLine = String(line + 1);
    scroll.dispatchEvent(new Event("openidea-hover-actions"));
  }

  /** Space before the first non-space character on the anchor line. The
   * action must stay left of the text; a line with no room gets no overlay. */
  private availableWidth(line: number): number {
    const docLine = this.view.state.doc.line(line + 1);
    const indent = docLine.text.length - docLine.text.trimStart().length;
    const characterWidth = (this.view as EditorView & { defaultCharacterWidth?: number }).defaultCharacterWidth ?? 8;
    const coords = this.view.coordsAtPos(docLine.from + indent);
    const content = this.view.contentDOM.getBoundingClientRect();
    const width = coords ? coords.left - content.left : indent * characterWidth;
    return Math.max(0, width - 4);
  }

  private handleMove(event: MouseEvent) {
    const content = this.view.contentDOM;
    if (!(event.target instanceof Node) || !content.contains(event.target)) {
      // Left the editing area (for example into the gutter): keep the hint.
      return;
    }
    const rect = content.getBoundingClientRect();
    if (event.clientX - rect.left > this.stripWidth()) {
      this.hide();
      return;
    }
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    const line = pos == null ? null : this.view.state.doc.lineAt(pos).number - 1;
    const matches = line == null ? [] : matchingActions(this.placed, line);
    if (!matches.length) {
      this.hide();
      return;
    }
    this.show(matches);
  }

  private show(matches: readonly PlacedHoverAction[]) {
    this.reserveLine(matches[0]!.action.line);
    const signature = matches
      .map(({ plugin, action }) => `${plugin}:${action.command}:${action.line}:${action.label}`)
      .join("|");
    if (signature !== this.currentSignature()) this.render(matches);
    if (!this.root.childElementCount) {
      this.shown = [];
      this.setVisible(false);
      return;
    }
    this.shown = [...matches];
    this.setVisible(true);
    this.reposition();
  }

  private currentSignature(): string {
    return this.shown
      .map(({ plugin, action }) => `${plugin}:${action.command}:${action.line}:${action.label}`)
      .join("|");
  }

  private render(matches: readonly PlacedHoverAction[]) {
    this.root.replaceChildren();
    const anchorLine = matches[0]!.action.line;
    const available = this.availableWidth(anchorLine);
    const gap = 3;
    const width = 16;
    const overflowWidth = 18;
    let visible = matches.length;
    let overflow = false;
    const group = (count: number, withOverflow: boolean) =>
      count * width + Math.max(0, count - 1) * gap + (withOverflow ? (count ? gap : 0) + overflowWidth : 0);
    if (group(matches.length, false) > available) {
      if (matches.length > 1 && group(1, true) <= available) {
        visible = 1;
        overflow = true;
      } else if (overflowWidth <= available) {
        visible = 0;
        overflow = true;
      } else {
        visible = 0;
      }
    }
    for (const match of matches.slice(0, visible)) this.appendAction(match);
    if (overflow) this.appendOverflow(matches);
  }

  private runAction(plugin: string, action: HoverAction) {
    void call(
      commands.lspExecuteCommand(this.ctx.doc, {
        title: action.tooltip ?? action.label,
        command: `openidea.plugin-language:${plugin}:${action.command}`,
        arguments: [JSON.stringify(action.argument)],
      }),
    ).catch(console.warn);
  }

  private appendAction({ plugin, action }: PlacedHoverAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${styles.button} cm-plugin-hover-action`;
    button.title = action.tooltip ?? action.label;
    button.setAttribute("aria-label", action.label || action.tooltip || tx`Hover action`);
    const icon = action.icon ? gutterIconMarkup(markerIcon(action.icon)) : null;
    if (icon) button.innerHTML = icon;
    else {
      const label = document.createElement("span");
      label.className = styles.label ?? "cm-plugin-hover-action-label";
      label.textContent = action.label;
      button.appendChild(label);
    }
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.runAction(plugin, action);
    });
    this.root.appendChild(button);
  }

  private appendOverflow(matches: readonly PlacedHoverAction[]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${styles.overflow} cm-plugin-hover-action-overflow`;
    button.textContent = "…";
    const label = tx`${matches.length} hover actions`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = button.getBoundingClientRect();
      showContextMenu(
        { x: rect.left, y: rect.bottom + 4 },
        matches.map(({ plugin, action }) => ({
          label: action.tooltip ?? action.label,
          verbatim: true,
          run: () => this.runAction(plugin, action),
        })),
        { owner: this.view.dom },
      );
    });
    this.root.appendChild(button);
  }

  private reposition() {
    if (!this.visible || !this.shown.length) return;
    const anchorLine = this.shown[0]!.action.line;
    if (anchorLine >= this.view.state.doc.lines) return this.hide();
    const line = this.view.state.doc.line(anchorLine + 1);
    const coords = this.view.coordsAtPos(line.from);
    if (!coords) return this.hide();
    const content = this.view.contentDOM.getBoundingClientRect();
    const editor = this.view.dom.getBoundingClientRect();
    const height = this.root.offsetHeight || 16;
    // Align the visible icon centers. The bulb is 18px wide with a 1px-padded
    // 16px icon; the action is a 16px button with a 14px SVG. Aligning only the
    // container left would leave the action 1px left of the bulb.
    const bulb = this.view.dom.querySelector<HTMLElement>(".cm-lsp-bulb");
    let left = content.left - editor.left + 4;
    const bulbIcon =
      bulb && getComputedStyle(bulb).display !== "none" && !bulb.classList.contains("cm-lsp-bulb-gutter")
        ? [...bulb.querySelectorAll<HTMLElement>(".cm-openidea-icon")].find(
            (icon) => getComputedStyle(icon).display !== "none",
          )
        : undefined;
    const actionIcon = this.root.querySelector<SVGElement>(".cm-plugin-hover-action svg");
    if (bulbIcon && actionIcon) {
      const bulbRect = bulbIcon.getBoundingClientRect();
      const actionRect = actionIcon.getBoundingClientRect();
      const rootRect = this.root.getBoundingClientRect();
      const actionCenter = actionRect.left + actionRect.width / 2 - rootRect.left;
      left = bulbRect.left + bulbRect.width / 2 - actionCenter - editor.left;
    } else if (bulb && getComputedStyle(bulb).display !== "none" && !bulb.classList.contains("cm-lsp-bulb-gutter")) {
      left = bulb.getBoundingClientRect().left - editor.left + 1;
    }
    this.root.style.left = `${Math.max(0, left)}px`;
    // Center on the line's visual row; the button's height changes independently
    // of the editor line height, so do not position from the row top alone.
    this.root.style.top = `${Math.round((coords.top + coords.bottom) / 2 - editor.top - height / 2)}px`;
  }

  private setVisible(visible: boolean) {
    this.visible = visible;
    this.root.dataset.visible = visible ? "true" : "false";
  }

  /**
   * Pointer leaves the editing area to the left: keep the hint (sticky).
   * Editor/window focus loss and tab hiding override that stickiness.
   */
  private hide() {
    if (!this.shown.length) return;
    if (document.activeElement instanceof Node && this.root.contains(document.activeElement)) {
      this.setVisible(true);
      return;
    }
    this.forceHide();
  }

  private forceHide() {
    if (!this.shown.length) return;
    this.shown = [];
    this.reserveLine(null);
    this.root.replaceChildren();
    this.setVisible(false);
  }

  private clear() {
    this.forceHide();
  }

  destroy() {
    this.view.contentDOM.removeEventListener("mousemove", this.onMove);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    this.root.removeEventListener("focusin", this.onFocusIn);
    this.view.dom.removeEventListener("focusout", this.onFocusOut);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.reserveLine(null);
    setHoverActions(this.ctx.doc, []);
    this.root.remove();
  }
}

/** Extension owned by the plugin-language-visuals ViewPlugin. */
export function hoverActionLayer(view: EditorView, ctx: EditorDocContext): HoverActionLayer {
  return new HoverActionLayer(view, ctx);
}
export type { HoverActionLayer };
