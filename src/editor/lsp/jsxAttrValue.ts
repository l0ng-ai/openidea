/**
 * JSX attribute values on `=`, as in WebStorm's "Add for JSX attribute: Based
 * on type": typing `=` after an attribute name that has no value yet inserts
 * `""` when the prop's type is string-like and `{}` otherwise, with the caret
 * between them. The type comes from the language server's hover on the name;
 * without an answer in time (no server, still starting) it falls back to `{}`.
 *
 * The `=` goes in at once and the pair follows as its own `input.complete`
 * step — undo removes the pair first and Tab steps out of it. Anything typed
 * meanwhile wins: the pair is dropped.
 */
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Markup } from "@/bindings";
import { commands, nextRequestId } from "@/platform/ipc";
import { editorPrefs } from "@/platform/editorSettings";
import { docOf, lspRequest } from "./lsp";
import { offsetToPos } from "./positions";

/** Languages whose editors parse JSX. */
const JSX_LANGUAGES = new Set(["typescriptreact", "javascriptreact"]);

/** How long the pair waits for the prop's type before falling back to `{}`. */
const WAIT_MS = 500;

type ValueKind = "quotes" | "braces";

/** The name of the value-less JSX attribute ending at `pos`, or null. */
function attributeNameBefore(state: EditorState, pos: number): SyntaxNode | null {
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (n?.parent && n.parent.name !== "JSXAttribute") n = n.parent;
  const attr = n?.parent;
  if (!n || !attr || attr.firstChild?.from !== n.from || n.to !== pos || attr.to !== pos) return null;
  return n;
}

/** Splits a type at its top-level `|`s: unions inside parentheses, generics, objects or strings stay whole. */
function unionMembers(type: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const ch = type[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch) && !(ch === ">" && type[i - 1] === "=")) depth--;
    else if (ch === "|" && depth === 0) {
      out.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(type.slice(start).trim());
  return out.filter(Boolean);
}

const STRING_MEMBER = /^(?:string|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)$/;

/** `string`, string literals and template literal types, optionally with `undefined` / `null`. */
export function isStringLikeType(type: string): boolean {
  const members = unionMembers(type).filter((m) => m !== "undefined" && m !== "null");
  return members.length > 0 && members.every((m) => STRING_MEMBER.test(m));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The delimiters for `attr`'s value from its hover: TypeScript shows
 * `(property) label: string` for a component prop and
 * `(property) React.HTMLAttributes<T>.className?: string | undefined` for a DOM one
 * (`HTMLAttributes<T>["aria-label"]?:` for a name that is not an identifier).
 */
export function attrValueKind(markup: Markup | null | undefined, attr: string): ValueKind {
  if (!markup) return "braces";
  const code = /```[^\n]*\n([\s\S]*?)```/.exec(markup.value)?.[1] ?? markup.value;
  const sig = code.replace(/\s+/g, " ").trim();
  const name = escape(attr);
  const typed = new RegExp(`(?:^|[\\s.)>])(?:${name}|\\[?"${name}"\\]?|'${name}')\\??\\s*:\\s*([\\s\\S]+)$`).exec(sig);
  return typed && isStringLikeType(typed[1]!) ? "quotes" : "braces";
}

async function valueKind(view: EditorView, nameFrom: number, attr: string): Promise<ValueKind> {
  const doc = docOf(view);
  if (!doc) return "braces";
  const state = view.state;
  const id = nextRequestId();
  const wanted = () => view.state.doc === state.doc;
  const hover = lspRequest(() => commands.lspHover(id, doc.doc, offsetToPos(state.doc, nameFrom)), wanted)
    .then((h) => attrValueKind(h?.contents, attr))
    .catch((): ValueKind => "braces");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), WAIT_MS)));
  const kind = await Promise.race([hover, timeout]);
  clearTimeout(timer);
  if (kind) return kind;
  void commands.cancelRequest(id).catch(() => {});
  return "braces";
}

async function insertValue(view: EditorView, nameFrom: number, attr: string) {
  const state = view.state;
  const after = state.selection.main.head;
  const kind = await valueKind(view, nameFrom, attr);
  if (!view.dom.isConnected || view.state.doc !== state.doc || view.state.selection.main.head !== after) return;
  const { pairQuotes, pairBrackets } = editorPrefs().smartKeys;
  if (kind === "quotes" ? !pairQuotes : !pairBrackets) return;
  view.dispatch({
    changes: { from: after, insert: kind === "quotes" ? '""' : "{}" },
    selection: EditorSelection.cursor(after + 1),
    userEvent: "input.complete",
  });
}

const attrValueInput = EditorView.inputHandler.of((view, from, to, text, insert) => {
  const { state } = view;
  if (text !== "=" || from !== to || state.readOnly || state.selection.ranges.length > 1) return false;
  const name = attributeNameBefore(state, from);
  if (!name || /["'{]/.test(state.sliceDoc(from, from + 1))) return false;
  const { pairQuotes, pairBrackets } = editorPrefs().smartKeys;
  if (!pairQuotes && !pairBrackets) return false;
  view.dispatch(insert());
  void insertValue(view, name.from, state.sliceDoc(name.from, name.to));
  return true;
});

/** `=` after a JSX attribute name fills in `""` or `{}` by the prop's type, in JSX / TSX editors. */
export function jsxAttrValueExtension(language: string): Extension {
  return JSX_LANGUAGES.has(language) ? attrValueInput : [];
}
