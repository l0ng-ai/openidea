/**
 * The composer's CodeMirror extensions. The text stays plain (`@src/a.rs:10-20`, `/triage`,
 * `> quote`) and is what's stored and sent; references to files of the draft are drawn as
 * chips over their text, commands tagged, and quote lines as a block without their `>`.
 *
 * A chip moves and deletes as one piece. Backspace right after one turns it back into its
 * text to edit (the completion opens on it); it folds again once the caret leaves it.
 *
 * Web links (`https://…`, `[label](url)`) are chips too, once the caret leaves them: a click
 * opens the page.
 *
 * A ``` block (pasted code or terminal output) is a card while the caret is outside it; a click
 * on the card, or the caret at its end, opens it as text.
 */
import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import type { AgentCommand } from "@/bindings";
import {
  commandArgHintAt,
  fencedBlocks,
  isQuoteLine,
  messageTokens,
  parseMention,
  type FileRef,
  type Mention,
} from "./composerModel";
import { linkSpans } from "./composerLinks";
import { chipElement, chipStyles, codeCardElement, linkChipElement, openReference } from "./ReferenceChip";

/** The draft's referenced files: mentions of these are chips. */
export const setReferences = StateEffect.define<readonly FileRef[]>();
const references = StateField.define<readonly FileRef[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setReferences)) return e.value;
    return value;
  },
});

/** Available slash commands: drives the inline argument hint after `/command `. */
export const setCommands = StateEffect.define<readonly AgentCommand[]>();
const commandsField = StateField.define<readonly AgentCommand[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCommands)) return e.value;
    return value;
  },
});

/** A reference or link drawn as a chip. */
interface Chip {
  from: number;
  to: number;
}

interface LineToken {
  kind: "file" | "command" | "link";
  from: number;
  to: number;
  value: string;
  /** A link's URL and label. */
  url?: string;
  label?: string | null;
}

/** `@`, `/` and link tokens of the line around `pos`, in document positions. */
function lineTokens(doc: Text, pos: number): LineToken[] {
  const line = doc.lineAt(pos);
  const links: LineToken[] = linkSpans(line.text).map((l) => ({
    kind: "link",
    from: line.from + l.from,
    to: line.from + l.to,
    value: line.text.slice(l.from, l.to),
    url: l.url,
    label: l.label,
  }));
  const out: LineToken[] = [...links];
  let offset = line.from;
  for (const token of messageTokens(line.text)) {
    const from = offset;
    const to = offset + token.value.length;
    offset = to;
    // `@` or `/` inside a link (its label or URL) is part of it.
    if (token.kind === "text" || links.some((l) => from < l.to && to > l.from)) continue;
    out.push({ kind: token.kind, from, to, value: token.value });
  }
  return out.sort((a, b) => a.from - b.from);
}

const unfold = StateEffect.define<number>();
/** Start of the chip being edited as text, while the caret stays in it. */
const unfolded = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(unfold)) return e.value;
    if (value === null) return null;
    const start = tr.changes.mapPos(value, 1);
    const head = tr.state.selection.main.head;
    const token = lineTokens(tr.state.doc, start).find((t) => t.from === start && t.kind !== "command");
    return token && head > token.from && head <= token.to ? start : null;
  },
});

class ChipWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly mention: Mention,
    readonly text: string,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.path === this.path && other.text === this.text;
  }
  toDOM(view: EditorView) {
    const chip: HTMLElement = chipElement(this.path, this.mention, () => removeChip(view, chip));
    // Keep the editor's focus and caret; a click opens the file.
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      openReference(this.path, this.mention);
    });
    return chip;
  }
  ignoreEvent() {
    return true;
  }
}

/** Deletes the chip at `dom`, with the space typed after it. */
function removeChip(view: EditorView, dom: HTMLElement) {
  const from = view.posAtDOM(dom);
  const at = view.state.field(painted).chips.find((c) => c.from === from);
  if (!at) return;
  const end = view.state.sliceDoc(at.to, at.to + 1) === " " ? at.to + 1 : at.to;
  view.dispatch({ changes: { from: at.from, to: end }, userEvent: "delete" });
  view.focus();
}

class LinkChipWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly label: string | null,
  ) {
    super();
  }
  eq(other: LinkChipWidget) {
    return other.url === this.url && other.label === this.label;
  }
  toDOM(view: EditorView) {
    const chip: HTMLElement = linkChipElement(this.url, this.label, () => removeChip(view, chip));
    // Keep the editor's focus and caret.
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    return chip;
  }
  ignoreEvent() {
    return true;
  }
}

class CodeCardWidget extends WidgetType {
  constructor(
    readonly info: string,
    readonly body: string,
  ) {
    super();
  }
  eq(other: CodeCardWidget) {
    return other.info === this.info && other.body === this.body;
  }
  toDOM(view: EditorView) {
    const range = (dom: HTMLElement) => {
      const from = view.posAtDOM(dom);
      return view.state.field(painted).cards.find((c) => c.from === from) ?? null;
    };
    const card: HTMLElement = codeCardElement(
      this.info,
      this.body,
      () => {
        const at = range(card);
        if (at) view.dispatch({ selection: { anchor: at.to } });
        view.focus();
      },
      () => {
        const at = range(card);
        if (!at) return;
        const end = view.state.sliceDoc(at.to, at.to + 1) === "\n" ? at.to + 1 : at.to;
        view.dispatch({ changes: { from: at.from, to: end }, userEvent: "delete" });
        view.focus();
      },
    );
    return card;
  }
  ignoreEvent() {
    return true;
  }
}

class ArgHintWidget extends WidgetType {
  constructor(readonly hint: string) {
    super();
  }
  eq(other: ArgHintWidget) {
    return other.hint === this.hint;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = chipStyles.argHint!;
    el.setAttribute("aria-hidden", "true");
    el.textContent = this.hint;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const quoteMarker = Decoration.replace({});
const codeLine = Decoration.line({ class: chipStyles.codeLine });

interface Painted {
  decorations: DecorationSet;
  atomic: DecorationSet;
  chips: readonly Chip[];
  cards: readonly { from: number; to: number }[];
}

function paint(state: EditorState): Painted {
  const refs = state.field(references);
  const editing = state.field(unfolded);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const chips: Chip[] = [];
  const cards: { from: number; to: number }[] = [];
  const { doc } = state;
  const head = state.selection.main.head;
  // Line numbers (1-based) inside ``` blocks: no chips or quotes there.
  const coded = new Set<number>();
  for (const fence of fencedBlocks(doc.toString().split("\n"))) {
    const from = doc.line(fence.open + 1).from;
    const to = doc.line(fence.close + 1).to;
    for (let n = fence.open + 1; n <= fence.close + 1; n++) coded.add(n);
    if (head > from && head <= to) {
      for (let n = fence.open + 1; n <= fence.close + 1; n++) decorations.push(codeLine.range(doc.line(n).from));
      continue;
    }
    const body =
      fence.close > fence.open + 1 ? doc.sliceString(doc.line(fence.open + 2).from, doc.line(fence.close).to) : "";
    const card = Decoration.replace({ widget: new CodeCardWidget(fence.info, body), block: true });
    decorations.push(card.range(from, to));
    atomic.push(card.range(from, to));
    cards.push({ from, to });
  }
  for (let n = 1; n <= doc.lines; n++) {
    if (coded.has(n)) continue;
    const line = doc.line(n);
    if (isQuoteLine(line.text)) {
      const prev = n > 1 && isQuoteLine(doc.line(n - 1).text);
      const next = n < doc.lines && isQuoteLine(doc.line(n + 1).text);
      const cls = [chipStyles.quoteLine, !prev && chipStyles.quoteFirst, !next && chipStyles.quoteLast];
      decorations.push(Decoration.line({ class: cls.filter(Boolean).join(" ") }).range(line.from));
      const marker = line.text.startsWith("> ") ? 2 : 1;
      decorations.push(quoteMarker.range(line.from, line.from + marker));
      atomic.push(quoteMarker.range(line.from, line.from + marker));
    }
    for (const token of lineTokens(doc, line.from)) {
      if (token.kind === "command") {
        decorations.push(Decoration.mark({ class: chipStyles.command }).range(token.from, token.to));
        continue;
      }
      if (token.kind === "link") {
        // Still being typed or pasted (the caret at its end), or opened to edit: as text.
        if (editing === token.from || (head > token.from && head <= token.to)) {
          decorations.push(Decoration.mark({ class: chipStyles.pending }).range(token.from, token.to));
          continue;
        }
        const chip = Decoration.replace({ widget: new LinkChipWidget(token.url!, token.label ?? null) });
        decorations.push(chip.range(token.from, token.to));
        atomic.push(chip.range(token.from, token.to));
        chips.push({ from: token.from, to: token.to });
        continue;
      }
      const mention = parseMention(token.value);
      const ref = mention && refs.find((f) => f.rel === mention.rel);
      if (!mention || !ref || editing === token.from) {
        decorations.push(Decoration.mark({ class: chipStyles.pending }).range(token.from, token.to));
        continue;
      }
      const chip = Decoration.replace({
        widget: new ChipWidget(ref.path, mention, token.value),
      });
      decorations.push(chip.range(token.from, token.to));
      atomic.push(chip.range(token.from, token.to));
      chips.push({ from: token.from, to: token.to });
    }
  }
  const argHint = commandArgHintAt(doc.toString(), head, state.field(commandsField));
  if (argHint) {
    decorations.push(Decoration.widget({ widget: new ArgHintWidget(argHint), side: 1 }).range(head));
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    chips,
    cards,
  };
}

const painted = StateField.define<Painted>({
  create: paint,
  update(value, tr) {
    // A ``` block opens while the caret is in it; a link is text while the caret is at its end;
    // a leading `/command ` shows its inline argument hint only while the caret sits at the end.
    const doc = tr.selection && tr.state.doc.toString();
    const selectionSensitive = !!doc && (doc.includes("```") || doc.includes("://") || doc.trimStart().startsWith("/"));
    const changed =
      tr.docChanged ||
      selectionSensitive ||
      tr.effects.some((e) => e.is(setReferences) || e.is(setCommands) || e.is(unfold)) ||
      tr.startState.field(unfolded) !== tr.state.field(unfolded);
    return changed ? paint(tr.state) : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (p) => p.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

/** Backspace right after a chip turns it back into its text. */
const unfoldOnBackspace = keymap.of([
  {
    key: "Backspace",
    run(view) {
      const sel = view.state.selection.main;
      if (!sel.empty) return false;
      const chip = view.state.field(painted).chips.find((c) => c.to === sel.head);
      if (!chip) return false;
      view.dispatch({ effects: unfold.of(chip.from), userEvent: "unfold" });
      return true;
    },
  },
]);

export function referenceExtensions(): Extension {
  return [references, commandsField, unfolded, painted, unfoldOnBackspace];
}
