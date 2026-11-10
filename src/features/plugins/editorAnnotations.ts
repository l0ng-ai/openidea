import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  hoverTooltip,
  type Tooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { registerEditorContribution, type EditorDocContext } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { onIdeEvent } from "@/platform/ipc";
import { renderMarkup } from "@/editor/lsp/markdown";
import { pluginsBackend } from "./backend";
import { defineUiPoint, type UiItem } from "./projection";

interface Declaration {
  id: string;
  command: string;
  refreshView: string;
  protocol: 1;
}
interface Prompt {
  id: string;
  label: string;
  markdown: string;
  hasMessages: boolean;
}
interface Snapshot {
  schemaVersion: 1;
  requestId: string;
  path: string;
  documentVersion: bigint;
  state: "ready" | "unavailable" | "stale";
  mode: "line" | "all" | "off";
  message?: string;
  lines: { line: number; promptId: string }[];
  prompts: Prompt[];
}

const MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
function withinLimit(text: string): boolean {
  return text.length <= MAX_BYTES && encoder.encode(text).length <= MAX_BYTES;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
// JSON.parse rounds u64 values above 2^53. Read only this top-level integer token losslessly.
function documentVersion(raw: string): bigint {
  let depth = 0;
  let version: bigint | undefined;
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
    else if (depth === 1 && JSON.parse(token) === "documentVersion") {
      const rest = raw.slice(match.index! + token.length);
      if (!/^\s*:/.test(rest)) continue;
      const integer = /^\s*:\s*(0|[1-9]\d*)(?=\s*[,}])/.exec(rest);
      if (!integer || integer[1]!.length > 20 || version !== undefined) throw new Error("Invalid document version");
      version = BigInt(integer[1]!);
      if (version > 18446744073709551615n) throw new Error("Invalid document version");
    }
  }
  if (version === undefined) throw new Error("Missing document version");
  return version;
}

function parseSnapshot(raw: string | null, requestId: string, path: string, lineCount: number): Snapshot {
  if (typeof raw !== "string" || !withinLimit(raw)) throw new Error("Invalid annotations response");
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    !keys(value, [
      "schemaVersion",
      "requestId",
      "path",
      "documentVersion",
      "state",
      "mode",
      "message",
      "lines",
      "prompts",
    ]) ||
    value.schemaVersion !== 1 ||
    value.requestId !== requestId ||
    value.path !== path ||
    typeof value.documentVersion !== "number" ||
    !["ready", "unavailable", "stale"].includes(value.state as string) ||
    !["line", "all", "off"].includes(value.mode as string) ||
    (value.message !== undefined && typeof value.message !== "string") ||
    !Array.isArray(value.lines) ||
    !Array.isArray(value.prompts)
  )
    throw new Error("Invalid annotations snapshot");
  const prompts = new Set<string>();
  for (const p of value.prompts) {
    if (
      !record(p) ||
      !keys(p, ["id", "label", "markdown", "hasMessages"]) ||
      !identifier(p.id) ||
      prompts.has(p.id) ||
      typeof p.label !== "string" ||
      typeof p.markdown !== "string" ||
      typeof p.hasMessages !== "boolean"
    )
      throw new Error("Invalid annotation prompt");
    prompts.add(p.id);
  }
  const lines = new Set<number>();
  for (const l of value.lines) {
    if (
      !record(l) ||
      !keys(l, ["line", "promptId"]) ||
      !Number.isInteger(l.line) ||
      (l.line as number) < 0 ||
      (l.line as number) >= lineCount ||
      lines.has(l.line as number) ||
      !identifier(l.promptId) ||
      !prompts.has(l.promptId)
    )
      throw new Error("Invalid annotation line");
    lines.add(l.line as number);
  }
  value.documentVersion = documentVersion(raw);
  return value as unknown as Snapshot;
}

class StatusWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: StatusWidget) {
    return this.text === other.text;
  }
  override toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-editor-annotation-status";
    dom.setAttribute("role", "status");
    dom.textContent = this.text;
    dom.title = this.text;
    return dom;
  }
}

type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const CARD_MIN = { width: 320, height: 160 } as const;
/** Natural size used when the host has not laid the card out yet (jsdom, first paint). */
const CARD_FALLBACK = { width: 560, height: 380 } as const;
const CARD_DEFAULT_HEIGHT = 380;

interface CardResize {
  edge: ResizeEdge;
  start: { left: number; top: number; width: number; height: number };
  size: { width: number; height: number };
}

/** Where the dragged card must sit so the edge opposite the pointer stays put. */
export function cardResizeOrigin(
  edge: ResizeEdge,
  start: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: edge.includes("w") ? start.left + start.width - size.width : start.left,
    top: edge.includes("n") ? start.top + start.height - size.height : start.top,
  };
}

const cardMaxSize = () => ({
  width: Math.max(CARD_MIN.width, Math.round(window.innerWidth * 0.9)),
  height: Math.max(CARD_MIN.height, Math.round(window.innerHeight * 0.8)),
});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const annotationTheme = EditorView.baseTheme({
  ".cm-editor-annotation, .cm-editor-annotation-status": {
    marginLeft: "0.5em",
    color: "var(--fg-muted)",
    fontSize: "0.9em",
    whiteSpace: "nowrap",
    display: "inline-block",
    maxWidth: "32em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    verticalAlign: "bottom",
  },
  ".cm-editor-annotation-tooltip": {
    maxWidth: "min(580px, 90vw)",
    overflowWrap: "anywhere",
  },
  ".cm-editor-annotation-content": {
    maxHeight: `${CARD_DEFAULT_HEIGHT}px`,
    overflow: "auto",
    padding: "10px 14px",
    boxSizing: "border-box",
  },
  ".cm-editor-annotation-resize": {
    position: "absolute",
    zIndex: "2",
    touchAction: "none",
  },
  ".cm-editor-annotation-resize[data-edge=n]": {
    top: "0",
    left: "8px",
    right: "8px",
    height: "6px",
    cursor: "row-resize",
  },
  ".cm-editor-annotation-resize[data-edge=s]": {
    bottom: "0",
    left: "8px",
    right: "8px",
    height: "6px",
    cursor: "row-resize",
  },
  ".cm-editor-annotation-resize[data-edge=w]": {
    left: "0",
    top: "8px",
    bottom: "8px",
    width: "6px",
    cursor: "col-resize",
  },
  ".cm-editor-annotation-resize[data-edge=e]": {
    right: "0",
    top: "8px",
    bottom: "8px",
    width: "6px",
    cursor: "col-resize",
  },
  ".cm-editor-annotation-resize[data-edge=nw]": {
    top: "0",
    left: "0",
    width: "10px",
    height: "10px",
    cursor: "nwse-resize",
  },
  ".cm-editor-annotation-resize[data-edge=ne]": {
    top: "0",
    right: "0",
    width: "10px",
    height: "10px",
    cursor: "nesw-resize",
  },
  ".cm-editor-annotation-resize[data-edge=sw]": {
    bottom: "0",
    left: "0",
    width: "10px",
    height: "10px",
    cursor: "nesw-resize",
  },
  ".cm-editor-annotation-resize[data-edge=se]": {
    bottom: "0",
    right: "0",
    width: "10px",
    height: "10px",
    cursor: "nwse-resize",
  },
  ".cm-editor-annotation-resize[data-edge=se]::after": {
    content: '""',
    position: "absolute",
    right: "3px",
    bottom: "3px",
    width: "6px",
    height: "6px",
    borderRight: "1px solid var(--fg-muted)",
    borderBottom: "1px solid var(--fg-muted)",
    opacity: "0.7",
  },
});

const redraw = StateEffect.define<null>();
const invalidate = StateEffect.define<null>();
let nextRequest = 0;

class AnnotationWidget extends WidgetType {
  constructor(
    readonly prompt: Prompt,
    readonly owner: string,
  ) {
    super();
  }
  override eq(other: AnnotationWidget) {
    return this.prompt === other.prompt;
  }
  override toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-editor-annotation";
    dom.textContent = ` + ${this.prompt.label}`;
    // Match VS Code's colored after-line model label: highlighted rather than muted.
    dom.style.color = "var(--accent)";
    dom.style.fontWeight = "600";
    dom.dataset.annotationOwner = this.owner;
    dom.dataset.promptId = this.prompt.id;
    return dom;
  }
}

interface Conversation {
  promptId: string;
  line: number;
  selection: number;
}
interface Card extends Conversation {
  dom: HTMLElement;
  content: HTMLElement;
  resize: CardResize | null;
  stopResize: (() => void) | null;
}

class Annotations {
  decorations: DecorationSet = Decoration.none;
  private pointer: HTMLElement | null = null;
  private owner = `annotation-${++nextRequest}`;
  private trackPointer = (event: MouseEvent) => {
    const widget = (event.target as Element | null)?.closest?.<HTMLElement>(".cm-editor-annotation");
    this.pointer = widget?.dataset.annotationOwner === this.owner ? widget : null;
  };
  private snapshot: Snapshot | null = null;
  private status: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private busy = false;
  private requestAbort: AbortController | null = null;
  private requestConversation: Conversation | null = null;
  private selection = 0;
  private conversation: Conversation | null = null;
  private attempts = new Map<string, "loading" | "failed">();
  private cards = new Set<Card>();
  private cardSize: { width: number; height: number } | null = null;
  private pending = false;
  private destroyed = false;
  private off: (() => void)[];

  constructor(
    private view: EditorView,
    private ctx: EditorDocContext,
    private item: UiItem<Declaration>,
    private serialize: (run: () => Promise<string | null>) => Promise<string | null>,
  ) {
    view.dom.addEventListener("mousemove", this.trackPointer, true);
    const refresh = () => {
      this.schedule(0);
      this.view.dispatch({ effects: [invalidate.of(null), redraw.of(null)] });
    };
    this.off = [
      pluginsBackend().onEvent((event) => {
        if (event.type === "viewChanged" && event.pluginId === item.pluginId && event.view === item.decl.refreshView)
          refresh();
      }),
      onIdeEvent("settingsChanged", refresh),
    ];
    this.schedule(0);
  }

  update(update: ViewUpdate) {
    if (update.selectionSet) {
      this.selection++;
      if (this.requestConversation) this.requestAbort?.abort();
      if (this.conversation) this.attempts.delete(this.conversation.promptId);
      this.conversation = null;
    }
    if (update.docChanged) {
      this.schedule(300);
      this.project();
    }
    if (update.selectionSet || update.transactions.some((t) => t.effects.some((e) => e.is(redraw)))) this.project();
  }

  private project() {
    const snapshot = this.snapshot;
    if (this.status) {
      const pos = this.view.state.doc.lineAt(this.view.state.selection.main.head).to;
      const messages = [this.status, snapshot?.message].filter((text): text is string => !!text);
      this.decorations = Decoration.set(
        messages.map((text, index) =>
          Decoration.widget({
            widget: new StatusWidget(text),
            side: index + 1,
          }).range(pos),
        ),
      );
      return;
    }
    if (!snapshot || snapshot.state !== "ready" || snapshot.mode === "off") {
      this.decorations = Decoration.none;
      return;
    }
    const doc = this.view.state.doc;
    const headLine = doc.lineAt(this.view.state.selection.main.head).number - 1;
    const prompts = new Map(snapshot.prompts.map((prompt) => [prompt.id, prompt]));
    const decorations = snapshot.lines
      .filter((line) => snapshot.mode === "all" || line.line === headLine)
      .map((line) =>
        Decoration.widget({
          widget: new AnnotationWidget(prompts.get(line.promptId)!, this.owner),
          side: 1,
        }).range(doc.line(line.line + 1).to),
      );
    if (snapshot.message)
      decorations.push(
        Decoration.widget({
          widget: new StatusWidget(snapshot.message),
          side: 2,
        }).range(doc.line(headLine + 1).to),
      );
    this.decorations = Decoration.set(decorations, true);
  }

  hover(pos: number): Tooltip | null {
    if (!this.pointer?.isConnected) return null;
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.state !== "ready" || snapshot.mode === "off") return null;
    const line = this.view.state.doc.lineAt(pos);
    const id = this.pointer.dataset.promptId;
    if (!snapshot.lines.some((l) => l.line === line.number - 1 && l.promptId === id)) return null;
    const prompt = snapshot.prompts.find((p) => p.id === id)!;
    return {
      pos: line.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-lsp-hover cm-editor-annotation-tooltip";
        // The floating card owns its scroll area so the resize grips stay put.
        dom.style.padding = "0";
        dom.style.overflow = "visible";
        const content = document.createElement("div");
        content.className = "cm-editor-annotation-content";
        dom.appendChild(content);
        const card: Card = {
          dom,
          content,
          resize: null,
          stopResize: null,
          promptId: prompt.id,
          line: line.number - 1,
          selection: this.selection,
        };
        this.cards.add(card);
        this.addResizeHandles(card);
        if (this.cardSize) this.setCardSize(card, this.cardSize);
        if (!prompt.hasMessages && !this.attempts.has(prompt.id)) {
          if (this.conversation) this.attempts.delete(this.conversation.promptId);
          this.attempts.set(prompt.id, "loading");
          this.conversation = card;
          queueMicrotask(() => void this.request());
        }
        this.renderCard(card);
        return {
          dom,
          // The user chose the size; CodeMirror must not shrink it to the space above the line.
          resize: false,
          positioned: () => this.holdResizedCard(card),
          destroy: () => this.disposeCard(card),
        };
      },
    };
  }

  private disposeCard(card: Card) {
    card.stopResize?.();
    this.cards.delete(card);
    const queued = this.conversation === card;
    const running = this.requestConversation === card;
    if (queued) this.conversation = null;
    if (running) this.requestAbort?.abort();
    if (queued || running) this.attempts.delete(card.promptId);
  }

  private renderCard(card: Card) {
    if (card.selection !== this.selection) return;
    const prompt = this.snapshot?.prompts.find((p) => p.id === card.promptId);
    if (!prompt) return;
    card.content.replaceChildren(
      renderMarkup(
        { kind: "markdown", value: prompt.markdown },
        this.ctx.uiMode,
        (href) =>
          !/^https?:\/\//i.test(href) ||
          Array.from(href).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
      ),
    );
    const loading = prompt.hasMessages
      ? null
      : this.attempts.get(prompt.id) === "loading"
        ? tx("Loading conversation…")
        : tx("Conversation unavailable");
    for (const text of [this.snapshot?.message, loading]) {
      if (!text) continue;
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = text;
      card.content.appendChild(status);
    }
  }

  /** Invisible grips on every edge and corner: dragging resizes the floating card. */
  private addResizeHandles(card: Card) {
    for (const edge of RESIZE_EDGES) {
      const handle = document.createElement("div");
      handle.className = "cm-editor-annotation-resize";
      handle.dataset.edge = edge;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("mousedown", (event) => this.startResize(card, edge, event));
      card.dom.appendChild(handle);
    }
  }

  /**
   * Freeze the card at an explicit size. The default card sizes itself to its
   * content; once the user resizes it, both the scroll viewport and the text
   * width follow that size until the editor view goes away.
   */
  private setCardSize(card: Card, size: { width: number; height: number }) {
    card.dom.style.width = `${size.width}px`;
    card.dom.style.height = `${size.height}px`;
    card.dom.style.maxWidth = "none";
    card.dom.style.maxHeight = "none";
    card.content.style.height = "100%";
    card.content.style.maxHeight = "none";
  }

  private startResize(card: Card, edge: ResizeEdge, event: MouseEvent) {
    if (event.button !== 0) return;
    card.stopResize?.();
    event.preventDefault();
    event.stopPropagation();
    const rect = card.dom.getBoundingClientRect();
    const width = rect.width || card.dom.offsetWidth || CARD_FALLBACK.width;
    const height = rect.height || card.dom.offsetHeight || CARD_FALLBACK.height;
    const start = {
      left: parseFloat(card.dom.style.left) || 0,
      top: parseFloat(card.dom.style.top) || 0,
      width,
      height,
    };
    card.resize = { edge, start, size: { width, height } };
    this.setCardSize(card, card.resize.size);
    const originX = event.clientX;
    const originY = event.clientY;
    const max = cardMaxSize();
    let moved = false;
    const move = (moveEvent: MouseEvent) => {
      if (moveEvent.buttons === 0) return end();
      moved = true;
      const dx = moveEvent.clientX - originX;
      const dy = moveEvent.clientY - originY;
      const size = {
        width: clamp(start.width + (edge.includes("e") ? dx : edge.includes("w") ? -dx : 0), CARD_MIN.width, max.width),
        height: clamp(
          start.height + (edge.includes("s") ? dy : edge.includes("n") ? -dy : 0),
          CARD_MIN.height,
          max.height,
        ),
      };
      card.resize = { edge, start, size };
      this.setCardSize(card, size);
      this.holdResizedCard(card);
    };
    const end = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", end, true);
      card.stopResize = null;
      if (moved && card.resize) this.cardSize = { ...card.resize.size };
      // The size is the user's; the position goes back to CodeMirror so the
      // card keeps following its line when the editor scrolls.
      card.resize = null;
    };
    // Capture phase: resize the card before CodeMirror's bubble-phase hover check
    // sees a pointer that has stepped past the previous edge and closes the card.
    card.stopResize = end;
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", end, true);
  }

  /**
   * CodeMirror repositions a tooltip from its anchor after every layout change.
   * Put the resized card back where the drag expects it: the edge opposite the
   * pointer stays fixed, so all eight directions feel like a real window.
   */
  private holdResizedCard(card: Card) {
    if (!card.resize) return;
    const { left, top } = cardResizeOrigin(card.resize.edge, card.resize.start, card.resize.size);
    card.dom.style.left = `${left}px`;
    card.dom.style.top = `${top}px`;
  }

  private schedule(delay: number) {
    this.generation++;
    this.requestAbort?.abort();
    this.conversation = null;
    this.attempts.clear();
    this.snapshot = null;
    this.status = null;
    this.pending = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.request();
    }, delay);
  }

  private get queuedPromptId() {
    return this.conversation?.promptId;
  }

  private async request() {
    if (this.destroyed || this.busy || this.timer !== null || (!this.pending && !this.conversation)) return;
    const conversation = this.pending ? null : this.conversation;
    const basis = this.snapshot;
    this.conversation = null;
    this.pending = false;
    this.busy = true;
    const generation = this.generation;
    const abort = new AbortController();
    this.requestAbort = abort;
    this.requestConversation = conversation;
    const { doc, selection } = this.view.state;
    const pos = (offset: number) => {
      const line = doc.lineAt(offset);
      return { line: line.number - 1, col: offset - line.from };
    };
    const request = {
      schemaVersion: 1,
      requestId: `annotations-${++nextRequest}`,
      operation: conversation ? "conversation" : "snapshot",
      ...(conversation ? { promptId: conversation.promptId } : {}),
      path: this.ctx.path,
      documentText: doc.toString(),
    };
    try {
      if (!withinLimit(request.documentText)) throw new Error("Document exceeds annotations limit");
      const result = await this.serialize(() => {
        if (
          this.destroyed ||
          abort.signal.aborted ||
          this.generation !== generation ||
          this.view.state.doc !== doc ||
          (conversation && conversation.selection !== this.selection)
        )
          return Promise.resolve(null);
        return pluginsBackend().runCommand(
          this.item.pluginId,
          this.item.decl.command,
          JSON.stringify(request),
          {
            path: this.ctx.path,
            language: this.ctx.language,
            selections: selection.ranges.map((r) => ({
              start: pos(r.from),
              end: pos(r.to),
            })),
          },
          [],
          undefined,
          undefined,
          abort.signal,
        );
      });
      if (this.destroyed || abort.signal.aborted || this.generation !== generation || this.view.state.doc !== doc)
        return;
      if (conversation && conversation.selection !== this.selection) return;
      const snapshot = parseSnapshot(result, request.requestId, this.ctx.path, doc.lines);
      if (
        conversation &&
        snapshot.mode !== "off" &&
        snapshot.state === "ready" &&
        (snapshot.documentVersion !== basis?.documentVersion ||
          !snapshot.lines.some((l) => l.line === conversation.line && l.promptId === conversation.promptId) ||
          !snapshot.prompts.find((p) => p.id === conversation.promptId)?.hasMessages)
      )
        throw new Error("Conversation is not available");
      if (conversation) this.attempts.delete(conversation.promptId);
      this.snapshot = snapshot;
      this.status =
        this.snapshot.mode === "off" || this.snapshot.state === "ready"
          ? null
          : this.snapshot.state === "stale"
            ? tx("Annotations stale")
            : tx("Annotations unavailable");
      this.view.dispatch({
        effects:
          this.snapshot.mode === "off" || this.snapshot.state !== "ready"
            ? [invalidate.of(null), redraw.of(null)]
            : redraw.of(null),
      });
    } catch {
      if (!this.destroyed && !abort.signal.aborted && this.generation === generation && this.view.state.doc === doc) {
        if (conversation) this.attempts.set(conversation.promptId, "failed");
        else {
          this.snapshot = null;
          this.status = tx("Annotations unavailable");
          this.view.dispatch({
            effects: [invalidate.of(null), redraw.of(null)],
          });
        }
      }
    } finally {
      if (this.requestAbort === abort) {
        this.requestAbort = null;
        this.requestConversation = null;
      }
      if (
        conversation &&
        this.generation === generation &&
        (abort.signal.aborted || conversation.selection !== this.selection) &&
        this.queuedPromptId !== conversation.promptId
      )
        this.attempts.delete(conversation.promptId);
      this.cards.forEach((card) => this.renderCard(card));
      this.busy = false;
      void this.request();
    }
  }

  destroy() {
    this.destroyed = true;
    this.requestAbort?.abort();
    this.off.forEach((off) => off());
    this.cards.forEach((card) => this.disposeCard(card));
    this.conversation = null;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.view.dom.removeEventListener("mousemove", this.trackPointer, true);
  }
}

export function defineEditorAnnotationsPoint(): () => void {
  // Split views and contributions share the command lane; each view coalesces its own latest work.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = (run: () => Promise<string | null>) => {
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
  return defineUiPoint<Declaration>("editorAnnotations", {
    project: (item) =>
      registerEditorContribution({
        id: `plugin.editorAnnotations.${item.pluginId}/${item.key}`,
        extensions: (ctx) => {
          if (ctx.virtual || !ctx.path) return [];
          const plugin = ViewPlugin.define((view) => new Annotations(view, ctx, item, serialize), {
            decorations: (value) => value.decorations,
          });
          return [
            annotationTheme,
            plugin,
            hoverTooltip((view, pos) => view.plugin(plugin)?.hover(pos) ?? null, {
              hideOnChange: true,
              hideOn: (tr) => tr.effects.some((e) => e.is(invalidate)),
            }),
          ];
        },
      }),
  });
}
