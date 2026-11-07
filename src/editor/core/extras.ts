/** Edit › Paste from History and Code › Unwrap/Remove: the parts that need popups or the backend. */
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { structure } from "@/editor/structure";
import { offsetToPos, posToOffset } from "@/editor/lsp/positions";
import { caretAnchor, openPopup } from "@/editor/lsp/popupStore";
import { executeAction } from "@/platform/actions";
import { clipLabel, clipboardHistory, isLinewiseClipboardText, recordClipboard } from "./clipboardHistory";
import { dispatchPaste } from "./cm/clipboard";
import { unwrapOptions, type ChainNode, type UnwrapOption } from "./cm/unwrap";
import type { EditorSlot } from "./model/slot";

const hint = (text: string) => void executeAction("editor.showHint", { text });

export function pasteText(view: EditorView, text: string) {
  if (view.state.readOnly) return;
  dispatchPaste(view, text);
  view.focus();
}

/** ⇧⌘V: chooses an earlier copied text; the choice also becomes the clipboard's content. */
export function pasteFromHistory(view: EditorView) {
  const items = clipboardHistory();
  if (!items.length) {
    hint("Nothing to paste: the clipboard history is empty");
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, view.state.selection.main.head),
    title: "Choose Content to Paste",
    items: items.map(({ text, linewise }, i) => {
      const { label, detail } = clipLabel(text);
      return {
        id: `${i}`,
        label,
        detail,
        preview:
          text
            .split(/\r\n?|\n/)
            .slice(1, 4)
            .join("  ⏎  ")
            .trim() || undefined,
        run: () => {
          recordClipboard(text, linewise);
          void navigator.clipboard?.writeText(text).catch(() => {});
          pasteText(view, text);
        },
      };
    }),
  });
}

function applyUnwrap(view: EditorView, o: UnwrapOption) {
  view.dispatch({
    changes: { from: o.from, to: o.to, insert: o.insert },
    selection: EditorSelection.cursor(o.from + /^\s*/.exec(o.insert)![0].length),
    scrollIntoView: true,
    userEvent: "input.unwrap",
  });
  view.focus();
}

/** ⇧⌘⌦: tree-sitter chain at the caret → the statements around it that can be unwrapped. */
export async function unwrapAtCaret(slot: EditorSlot) {
  const view = slot.view;
  if (!view || view.state.readOnly) return;
  const language = slot.model.getMeta().language;
  const tree = await structure.support(language).then(
    (s) => s.tree,
    () => false,
  );
  if (!tree) {
    hint("Unwrap/Remove is not available for this language");
    return;
  }
  await slot.model.sync.whenIdle();
  const v = slot.view;
  if (!v) return;
  const state = v.state;
  const head = state.selection.main.head;
  const pos = offsetToPos(state.doc, head);
  const at = await structure.nodeAt(slot.model.doc, { start: pos, end: pos }).catch(() => null);
  if (!at || slot.view !== v || v.state.doc !== state.doc) return;
  const chain: ChainNode[] = [at.node, ...at.ancestors].map((n) => ({
    kind: n.kind,
    from: posToOffset(state.doc, n.range.start),
    to: posToOffset(state.doc, n.range.end),
    field: n.field,
  }));
  const options = unwrapOptions(state.doc, chain);
  if (!options.length) {
    hint("Nothing to unwrap here");
    return;
  }
  if (options.length === 1) {
    applyUnwrap(v, options[0]!);
    return;
  }
  openPopup({
    kind: "list",
    anchor: caretAnchor(v, head),
    title: "Choose the Statement to Unwrap/Remove",
    items: options.map((o, i) => ({
      id: `${i}`,
      label: o.label,
      preview: state.sliceDoc(o.target.from, Math.min(o.target.to, state.doc.lineAt(o.target.from).to)).trim(),
      run: () => {
        if (slot.view === v && v.state.doc === state.doc) applyUnwrap(v, o);
      },
    })),
  });
}

/**
 * Edit › Paste as Plain Text (⌥⇧⌘V): the clipboard text exactly as copied,
 * without Reformat on Paste (its filter only handles `input.paste`).
 */
export async function pasteAsPlainText(view: EditorView) {
  if (view.state.readOnly) return;
  let text: string;
  try {
    text = (await navigator.clipboard?.readText()) ?? "";
  } catch {
    hint("Cannot read the clipboard");
    return;
  }
  if (!text && !isLinewiseClipboardText(text)) return;
  dispatchPaste(view, text, "input.pastePlain");
  view.focus();
}
