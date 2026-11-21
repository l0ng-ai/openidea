/**
 * Parameter info (⌘P, and automatically after `(` / `,`): a tooltip above the
 * caret listing the signatures with the active parameter in bold. While open
 * it follows the caret and closes when the server reports no signature;
 * ⇥ / ⇧⇥ move to the next / previous argument.
 */
import { EditorSelection, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { completionStatus, hasNextSnippetField, hasPrevSnippetField } from "@codemirror/autocomplete";
import {
  EditorView,
  ViewPlugin,
  keymap,
  repositionTooltips,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { commands, type SignatureHelp } from "@/platform/ipc";
import { tooltipBounds } from "@/editor/core/cm/setup";
import { docOf, lspRequest, reportLspError, debounce } from "./lsp";
import { offsetToPos } from "./positions";
import { showHint } from "./hint";
import { renderMarkup, isEmptyMarkup } from "./markdown";
import { editorPrefs } from "@/platform/editorSettings";
import { inplaceRenameActive } from "./inplaceRename";

interface SigState {
  pos: number;
  help: SignatureHelp;
}

const setSignature = StateEffect.define<SigState | null>();

const signatureField = StateField.define<SigState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSignature)) return e.value;
    if (value && tr.docChanged) return { ...value, pos: tr.changes.mapPos(value.pos) };
    return value;
  },
  provide: (f) => showTooltip.from(f, (s) => (s ? signatureTooltip(s) : null)),
});

/** Splits a signature label around the active parameter's UTF-16 range. */
export function splitSignature(label: string, params: ReadonlyArray<[number, number]>, active: number) {
  const range = params[active];
  if (!range) return { before: label, param: "", after: "" };
  const [s, e] = range;
  return { before: label.slice(0, s), param: label.slice(s, e), after: label.slice(e) };
}

/** Whether an overload can take an argument at `index` (varargs take any number). */
export function acceptsParameter(sig: { label: string; parameters: ReadonlyArray<[number, number]> }, index: number) {
  if (index < sig.parameters.length) return true;
  const last = sig.parameters[sig.parameters.length - 1];
  return !!last && /\.\.\.|^\s*\*/.test(sig.label.slice(last[0], last[1]));
}

function signatureTooltip(s: SigState): Tooltip {
  return {
    pos: s.pos,
    above: true,
    strictSide: false,
    create: (view) => {
      const { signatures, activeSignature, activeParameter } = s.help;
      const dom = document.createElement("div");
      dom.className = "cm-lsp-signature";
      dom.classList.toggle("cm-lsp-signature-overloads", signatures.length > 1);
      dom.setAttribute("role", "tooltip");
      let active: HTMLElement | null = null;
      signatures.forEach((sig, i) => {
        const row = document.createElement("div");
        row.className = "cm-lsp-signature-row";
        if (i === activeSignature) {
          row.classList.add("cm-lsp-signature-active");
          row.setAttribute("aria-current", "true");
          active = row;
        } else if (!acceptsParameter(sig, activeParameter)) row.classList.add("cm-lsp-signature-disabled");
        const parts = splitSignature(sig.label, sig.parameters, activeParameter);
        row.append(parts.before);
        if (parts.param) {
          const b = document.createElement("b");
          b.textContent = parts.param;
          row.appendChild(b);
          if (i === activeSignature) active = b;
        }
        row.append(parts.after);
        dom.appendChild(row);
      });
      const doc = signatures[activeSignature]?.documentation;
      if (doc && !isEmptyMarkup(doc) && signatures.length === 1) {
        const d = renderMarkup(doc);
        d.classList.add("cm-lsp-signature-doc");
        dom.appendChild(d);
      }
      const fit = ({ left, right }: { left: number; right: number }) => {
        const width = `${Math.max(0, Math.floor(right - left))}px`;
        if (dom.style.getPropertyValue("--cm-signature-width") === width) return false;
        dom.style.setProperty("--cm-signature-width", width);
        return true;
      };
      // Reveal the current parameter after wrapping or a vertical clamp. Leave manual scrolling alone.
      let fittedWidth = 0;
      let fittedHeight = 0;
      return {
        dom,
        mount: () => void fit(tooltipBounds(view)),
        positioned: (space) => {
          if (fit(space)) {
            repositionTooltips(view);
            return;
          }
          if (!active || (fittedWidth === dom.clientWidth && fittedHeight === dom.clientHeight)) return;
          fittedWidth = dom.clientWidth;
          fittedHeight = dom.clientHeight;
          const top = dom.getBoundingClientRect().top + dom.clientTop;
          const parameter = active.getBoundingClientRect();
          const below = parameter.bottom - (top + fittedHeight);
          if (parameter.top < top || parameter.height >= fittedHeight) dom.scrollTop += parameter.top - top;
          else if (below > 0) dom.scrollTop += below;
        },
      };
    },
  };
}

async function fetchSignature(view: EditorView, explicit: boolean) {
  const doc = docOf(view);
  if (!doc) return;
  const state = view.state;
  const head = state.selection.main.head;
  try {
    const help = await lspRequest(() => commands.lspSignatureHelp(doc.doc, offsetToPos(state.doc, head)));
    if (view.state.doc !== state.doc && !explicit) return;
    const current = view.state.field(signatureField, false);
    if (!help || !help.signatures.length) {
      if (current) view.dispatch({ effects: setSignature.of(null) });
      if (explicit) showHint(view, "No parameters");
      return;
    }
    view.dispatch({ effects: setSignature.of({ pos: Math.min(head, view.state.doc.length), help }) });
  } catch (e) {
    if (view.state.field(signatureField, false)) view.dispatch({ effects: setSignature.of(null) });
    reportLspError(view, e, explicit);
  }
}

/**
 * The caret was left inside the `()` of a completed call whose snippet doesn't
 * say whether it takes arguments (jdtls `new ArrayList<>()`): parameter info
 * when some signature has parameters, else the caret moves past `)`.
 */
export async function parameterInfoOrLeave(view: EditorView, inside: number) {
  const doc = docOf(view);
  const state = view.state;
  let help: SignatureHelp | null = null;
  try {
    if (doc) help = await lspRequest(() => commands.lspSignatureHelp(doc.doc, offsetToPos(state.doc, inside)));
  } catch {
    // No signature help: treated as nothing to fill in.
  }
  if (view.state.doc !== state.doc || view.state.selection.main.head !== inside) return;
  if (help?.signatures.some((sig) => sig.parameters.length))
    view.dispatch({ effects: setSignature.of({ pos: inside, help }) });
  else view.dispatch({ selection: EditorSelection.cursor(inside + 1) });
}

/** ⌘P or the completion command `editor.action.triggerParameterHints`. */
export function triggerSignatureHelp(view: EditorView, explicit = false) {
  void fetchSignature(view, explicit);
}

const signaturePlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void fetchSignature(this.view, false), 120);
    private popupTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private view: EditorView) {}
    /** Code Completion › "Show the parameter info popup in N ms". */
    private autoPopup() {
      const p = editorPrefs().completion;
      if (!p.parameterInfo) return;
      clearTimeout(this.popupTimer);
      this.popupTimer = setTimeout(() => void fetchSignature(this.view, false), Math.max(0, p.parameterInfoDelay));
    }
    update(u: ViewUpdate) {
      const active = u.state.field(signatureField, false);
      let typedTrigger = false;
      if (
        u.docChanged &&
        u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("input.complete"))
      ) {
        // The character before the caret: `(` is followed by an auto-inserted `)`.
        const head = u.state.selection.main.head;
        const before = u.state.sliceDoc(Math.max(0, head - 1), head);
        typedTrigger = before === "(" || before === ",";
      }
      if (typedTrigger && !active) this.autoPopup();
      else if (typedTrigger || (active && (u.docChanged || u.selectionSet))) this.refresh();
    }
    destroy() {
      clearTimeout(this.popupTimer);
      this.refresh.cancel();
    }
  },
);

// ---------------------------------------------------------------------------
// ⇥ / ⇧⇥: next / previous argument while parameter info is shown

const OPEN = "([{";
const CLOSE = ")]}";

/** Skips a string literal starting at `i` (its quote); returns the index after it. */
function skipString(text: string, i: number): number {
  const q = text[i]!;
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\") j++;
    else if (text[j] === "\n" && q !== "`") break;
    j++;
  }
  return j + 1;
}

const isQuote = (c: string) => c === '"' || c === "'" || c === "`";

/** The `(` of the innermost call around `pos`, scanning brackets outside strings and line comments. */
export function enclosingParen(text: string, pos: number, window = 4000): number | null {
  const start = Math.max(0, pos - window);
  const stack: number[] = [];
  for (let i = start; i < pos; i++) {
    const c = text[i]!;
    if (isQuote(c) && !(c === "'" && /\w/.test(text[i - 1] ?? ""))) {
      i = skipString(text, i) - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < pos && text[i] !== "\n") i++;
    } else if (OPEN.includes(c)) stack.push(i);
    else if (CLOSE.includes(c)) stack.pop();
  }
  for (let k = stack.length - 1; k >= 0; k--) if (text[stack[k]!] === "(") return stack[k]!;
  return null;
}

/** Argument spans (trimmed; empty ones collapse to where they would start) of the call opened at `open`. */
export function argumentSpans(text: string, open: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let depth = 0;
  let argStart = open + 1;
  const push = (end: number) => {
    let from = argStart;
    let to = end;
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    out.push({ from, to });
  };
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (isQuote(c) && !(c === "'" && /\w/.test(text[i - 1] ?? ""))) i = skipString(text, i) - 1;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) {
        push(i);
        return out.length === 1 && out[0]!.from === out[0]!.to ? [] : out;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      push(i);
      argStart = i + 1;
    }
  }
  return out;
}

/** Caret target of ⇥ (`dir` 1) / ⇧⇥ (-1) in the call around `pos`; null at the ends (the key then does its usual thing). */
export function argumentStop(text: string, pos: number, dir: 1 | -1): number | null {
  const open = enclosingParen(text, pos);
  if (open === null) return null;
  const args = argumentSpans(text, open);
  if (!args.length) return null;
  // The argument the caret is in: past an argument's separating comma it is that argument.
  let current = 0;
  for (let i = 1; i < args.length; i++) if (pos > text.lastIndexOf(",", args[i]!.from)) current = i;
  const target = args[current + dir];
  return target ? target.from : null;
}

function moveToArgument(view: EditorView, dir: 1 | -1): boolean {
  const state = view.state;
  if (!state.field(signatureField, false) || state.readOnly) return false;
  if (state.selection.ranges.length > 1 || completionStatus(state) === "active") return false;
  // Snippet / template fields and the in-place rename own ⇥.
  if (dir > 0 ? hasNextSnippetField(state) : hasPrevSnippetField(state)) return false;
  if (inplaceRenameActive(state)) return false;
  const head = state.selection.main.head;
  const to = argumentStop(state.doc.toString(), head, dir);
  if (to === null || to === head) return false;
  view.dispatch({ selection: EditorSelection.cursor(to), scrollIntoView: true, userEvent: "select" });
  return true;
}

/**
 * Next / Previous Parameter keys. Registered after the template contributions
 * (see `index.ts`) so live template / postfix expansion keeps ⇥ first; the
 * lookup, snippet fields and the in-place rename are checked explicitly.
 */
export const parameterTabKeys: Extension = Prec.high(
  keymap.of([
    { key: "Tab", run: (v) => moveToArgument(v, 1) },
    { key: "Shift-Tab", run: (v) => moveToArgument(v, -1) },
  ]),
);

export function signatureExtension(): Extension {
  return [
    signatureField,
    signaturePlugin,
    // Highest: Escape closes parameter info before it leaves a snippet.
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (!view.state.field(signatureField, false)) return false;
            view.dispatch({ effects: setSignature.of(null) });
            return true;
          },
        },
      ]),
    ),
    EditorView.focusChangeEffect.of((state, focusing) =>
      !focusing && state.field(signatureField, false) ? setSignature.of(null) : null,
    ),
  ];
}
