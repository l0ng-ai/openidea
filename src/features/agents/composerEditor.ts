/**
 * The composer's CodeMirror extensions. The text stays plain (`@src/a.rs:10-20`, `/triage`,
 * `> quote`) and is what's stored and sent; references to files of the draft are drawn as
 * chips over their text, commands tagged, and quote lines as a block without their `>`.
 *
 * A chip moves and deletes as one piece. Backspace right after one turns it back into its
 * text to edit (the completion opens on it); it folds again once the caret leaves it.
 */
import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { isQuoteLine, messageTokens, parseMention, type FileRef, type Mention } from "./composerModel";
import { chipElement, chipStyles, openReference } from "./ReferenceChip";

/** The draft's referenced files: mentions of these are chips. */
export const setReferences = StateEffect.define<readonly FileRef[]>();
const references = StateField.define<readonly FileRef[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setReferences)) return e.value;
    return value;
  },
});

interface Chip {
  from: number;
  to: number;
  path: string;
  mention: Mention;
}

/** `@` and `/` tokens of the line around `pos`, in document positions. */
function lineTokens(doc: Text, pos: number) {
  const line = doc.lineAt(pos);
  const out: {
    kind: "file" | "command";
    from: number;
    to: number;
    value: string;
  }[] = [];
  let offset = line.from;
  for (const token of messageTokens(line.text)) {
    if (token.kind !== "text")
      out.push({
        kind: token.kind,
        from: offset,
        to: offset + token.value.length,
        value: token.value,
      });
    offset += token.value.length;
  }
  return out;
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
    const token = lineTokens(tr.state.doc, start).find((t) => t.from === start && t.kind === "file");
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
  toDOM() {
    const chip = chipElement(this.path, this.mention);
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

const quoteMarker = Decoration.replace({});

interface Painted {
  decorations: DecorationSet;
  atomic: DecorationSet;
  chips: readonly Chip[];
}

function paint(state: EditorState): Painted {
  const refs = state.field(references);
  const editing = state.field(unfolded);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const chips: Chip[] = [];
  const { doc } = state;
  for (let n = 1; n <= doc.lines; n++) {
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
      chips.push({ from: token.from, to: token.to, path: ref.path, mention });
    }
  }
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    chips,
  };
}

const painted = StateField.define<Painted>({
  create: paint,
  update(value, tr) {
    const changed =
      tr.docChanged ||
      tr.effects.some((e) => e.is(setReferences) || e.is(unfold)) ||
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
  return [references, unfolded, painted, unfoldOnBackspace];
}
