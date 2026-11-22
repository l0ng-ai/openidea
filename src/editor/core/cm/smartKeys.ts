/**
 * IDEA-style Tab, smart Backspace, smart angle brackets, Tab out of
 * auto-inserted brackets and quotes, and `;` moved to the statement end.
 */
import {
  EditorSelection,
  StateEffect,
  countColumn,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import {
  getIndentUnit,
  getIndentation,
  indentString,
  indentUnit,
  matchBrackets,
  syntaxTree,
} from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { indentMore } from "@codemirror/commands";
import { visibleColumn } from "./visibleColumn";
import { literalAt } from "./literals";
import { SEMICOLON_LANGS, codeEnd, lineCommentToken } from "./editing";

// --- Tab -------------------------------------------------------------------------------

/**
 * Tab: steps out of an auto-inserted pair (when enabled); with a selection
 * holding more than whitespace, indents the selected lines; otherwise inserts
 * whitespace at each caret up to the next indent stop (a tab character when
 * the code style uses tabs). Live templates / Emmet get Tab first.
 */
export const insertTab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  if (tabOutOfScope(view)) return true;
  if (state.selection.ranges.some((r) => !r.empty && state.sliceDoc(r.from, r.to).trim())) return indentMore(view);
  const useTab = state.facet(indentUnit) === "\t";
  const size = Math.max(1, getIndentUnit(state));
  const tr = state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from);
    const col = visibleColumn(line.text, r.from - line.from, state.tabSize);
    const insert = useTab ? "\t" : " ".repeat(size - (col % size));
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Tab ahead of the default `indentWithTab` (⇧Tab stays Unindent). */
export const tabKeymap: Extension = keymap.of([{ key: "Tab", run: insertTab }]);

// --- Backspace -------------------------------------------------------------------------------

/** Languages whose layout is indentation: IDEA keeps "to nearest indent position" there. */
const NEAREST_INDENT_LANGS = new Set(["python", "gdscript", "yaml", "shellscript"]);

export function smartBackspaceApplies(mode: string, language: string | undefined): boolean {
  return mode === "autoindent" && !NEAREST_INDENT_LANGS.has(language ?? "");
}

/** The change one Backspace makes at `pos` in "To proper indent position" mode, or null to delete normally. */
export function autoIndentBackspace(
  state: EditorState,
  pos: number,
): { from: number; to: number; insert: string } | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (/[^ \t]/.test(doc.sliceString(line.from, pos))) return null;
  const target = getIndentation(state, line.from);
  if (target === null) return null;
  const end = pos + /^[ \t]*/.exec(doc.sliceString(pos, line.to))![0].length;
  const current = countColumn(doc.sliceString(line.from, end), state.tabSize);
  if (current > target) return { from: line.from, to: end, insert: indentString(state, target) };
  if (line.number === 1) return end > 0 ? { from: 0, to: end, insert: "" } : null;
  const prev = doc.line(line.number - 1);
  const prevEnd = prev.from + prev.text.trimEnd().length;
  if (prevEnd === prev.from && prevEnd !== 0) {
    // A blank line above: the text moves up, at its proper indent.
    return { from: prevEnd, to: end, insert: indentString(state, target) };
  }
  const before = doc.sliceString(prev.from, prevEnd);
  const after = doc.sliceString(end, line.to);
  const space = !after || !before || /[([{]$/.test(before) || /^[)\]}.,;]/.test(after) ? "" : " ";
  return { from: prevEnd, to: end, insert: space };
}

/** Backspace in leading whitespace: to the proper indent, or joined with the line above when already there. */
export const smartBackspace: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
  const plans = state.selection.ranges.map((r) => autoIndentBackspace(state, r.head));
  if (plans.some((p) => !p)) return false;
  const tr = state.changeByRange((r) => {
    const p = plans[state.selection.ranges.indexOf(r)]!;
    return { changes: p, range: EditorSelection.cursor(p.from + p.insert.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "delete.backward" }));
  return true;
};

// --- Tab out of brackets / quotes ------------------------------------------------------------

// `<>` pairs inserted by the smart angle brackets below land here too, so Tab steps over `>`.
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", '"': '"', "'": "'", "`": "`" };

interface Scope {
  from: number;
  to: number;
}

const leaveScopes = StateEffect.define<readonly number[]>();

/** Inside each pair the editor inserted itself; Tab at a scope's end steps over the closing character. */
const tabOutScopes = StateField.define<readonly Scope[]>({
  create: () => [],
  update(scopes, tr) {
    for (const e of tr.effects) if (e.is(leaveScopes)) scopes = scopes.filter((s) => !e.value.includes(s.to));
    if (!tr.docChanged) return scopes;
    const caret = tr.startState.selection.main.head;
    let next: Scope[] = scopes.filter((s) => {
      let keep = true;
      tr.changes.iterChangedRanges((fromA, toA) => {
        const outside = fromA < s.from || toA > s.to;
        if (outside && (caret < s.from || caret > s.to || (toA >= s.from && fromA <= s.to))) keep = false;
      });
      return keep;
    });
    next = next.map((s) => ({ from: tr.changes.mapPos(s.from, -1), to: tr.changes.mapPos(s.to, 1) }));
    return [...next, ...insertedPairs(tr)];
  },
});

/** Empty scopes between bracket / quote pairs a typing or completion transaction inserted. */
function insertedPairs(tr: Transaction): Scope[] {
  const completed = tr.isUserEvent("input.complete");
  if (!completed && !tr.isUserEvent("input.type")) return [];
  const out: Scope[] = [];
  tr.changes.iterChanges((_fa, _ta, _fromB, toB, inserted) => {
    const text = inserted.toString();
    // Typing inserts just the pair; a completion inserts a whole word plus its `()`, so the
    // pair is the tail of the inserted text.
    const pair = completed ? text.slice(-2) : text;
    if (pair.length !== 2 || PAIRS[pair[0]!] !== pair[1]) return;
    const inside = toB - 1;
    // A call snippet without stops leaves the caret after `)` and a later selection-only
    // transaction moves it back inside. Register the pair while the text is inserted: that
    // transaction does not change the document, so the scope survives until the caret arrives.
    if (completed || tr.newSelection.ranges.some((r) => r.empty && r.head === inside))
      out.push({ from: inside, to: inside });
  });
  return out;
}

export const tabOutOfScope: Command = (view) => {
  const { state } = view;
  const scopes = state.field(tabOutScopes, false);
  if (!scopes?.length || state.selection.ranges.some((r) => !r.empty || !scopes.some((s) => s.to === r.head)))
    return false;
  view.dispatch({
    selection: EditorSelection.create(
      state.selection.ranges.map((r) => EditorSelection.cursor(Math.min(r.head + 1, state.doc.length))),
      state.selection.mainIndex,
    ),
    effects: leaveScopes.of(state.selection.ranges.map((r) => r.head)),
    userEvent: "select",
  });
  return true;
};

/** Settings › Smart Keys › "Jump outside closing bracket/quote with Tab" (Tab itself is `insertTab`). */
export const tabOut: Extension = tabOutScopes;

// --- closing quote ---------------------------------------------------------------------------

/** `quote` at `pos` closes the string literal the caret is in (typed or not, the pair's end). */
export function closesStringAt(state: EditorState, pos: number, quote: string): boolean {
  if (state.sliceDoc(pos, pos + 1) !== quote) return false;
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1);
    n;
    n = n.parent
  ) {
    if (n.to > pos + 1) break;
    if (n.to === pos + 1 && n.from < pos && /String|Char|Template|Rune/.test(n.type.name)) return true;
  }
  return false;
}

/** Typing a quote right before the closing quote of a string literal steps over it, as in IDEA. */
export const skipClosingQuote = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (!/^["'`]$/.test(text) || view.state.readOnly) return false;
  const { state } = view;
  const sel = state.selection;
  if (!sel.ranges.every((r) => r.empty && closesStringAt(state, r.head, text))) return false;
  view.dispatch({
    selection: EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.cursor(r.head + 1)),
      sel.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

// --- closing bracket -------------------------------------------------------------------------

const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Count of `ch` in `text` outside string literals. */
function countOutsideStrings(text: string, ch: string): number {
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === ch) n++;
  }
  return n;
}

/**
 * Typing `)` `]` `}` right before the same bracket steps over it when it already closes a pair
 * (typed or not), as in IDEA; a line still missing a closer of that kind gets the new one.
 */
export const skipClosingBracket = EditorView.inputHandler.of((view, _from, _to, text) => {
  const open = OPENER[text];
  if (!open || view.state.readOnly) return false;
  const { state } = view;
  const sel = state.selection;
  const steps = sel.ranges.every((r) => {
    if (!r.empty || state.sliceDoc(r.head, r.head + 1) !== text) return false;
    if (!matchBrackets(state, r.head + 1, -1)?.matched) return false;
    const line = state.doc.lineAt(r.head).text;
    return countOutsideStrings(line, open) <= countOutsideStrings(line, text);
  });
  if (!steps) return false;
  view.dispatch({
    selection: EditorSelection.create(
      sel.ranges.map((r) => EditorSelection.cursor(r.head + 1)),
      sel.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

// --- smart angle brackets --------------------------------------------------------------------

/**
 * `<` pairs into `<>` only where the syntax tree says a generic type argument
 * list starts, as in IDEA: after a type name in Java / Kotlin / C# /
 * TypeScript, or a Rust turbofish — under the existing Insert pair bracket
 * option, with no setting of its own. Languages without a rule never pair, so
 * a plain `<` stays literal wherever it could be a tag opener or a comparison:
 * `a < b`, `i <= n` and `x << 2` never pair (the caret sits in a value
 * position there), nor do HTML / JSX tags or literals.
 */

/** The identifier immediately before `pos`, or "" when the caret is not right after one. */
function wordBefore(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return /[A-Za-z_$][\w$]*$/.exec(line.text.slice(0, pos - line.from))?.[0] ?? "";
}

/** The caret is inside a literal: never pair there, whatever the language rule says. */
/** C++ template syntax, not a template literal. */
const CPP_TEMPLATE_NODE = /^Template(Function|Type|Method|ArgumentList|ParameterList|Declaration|Instantiation)$/;

function inLiteral(state: EditorState, pos: number): boolean {
  for (
    let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, -1);
    n;
    n = n.parent
  )
    if (/string|comment|template|rune/i.test(n.name) && !CPP_TEMPLATE_NODE.test(n.name)) return true;
  return false;
}

/** Java: a type name (`List`, `new ArrayList`), inside type arguments, or a generic-able declaration name. */
function javaTypePosition(state: EditorState, pos: number): boolean {
  const n = syntaxTree(state).resolveInner(pos, -1);
  const parent = n.parent;
  if (n.name === "TypeName" || n.name === "TypeArguments" || parent?.name === "TypeArguments") return true;
  if (
    n.name === "Definition" &&
    parent &&
    [
      "ClassDeclaration",
      "InterfaceDeclaration",
      "EnumDeclaration",
      "RecordDeclaration",
      "ConstructorDeclaration",
    ].includes(parent.name)
  )
    return true;
  // A recovered expression identifier only starts a type argument list when it
  // is a type by convention (`List<String> x;` mid-typing): values are
  // lowercase, so `a < b` / `i <= n` / `x << 2` stay comparisons.
  if (n.name === "Identifier" && parent?.name !== "MarkerAnnotation" && parent?.name !== "Annotation")
    return /^[A-Z]/.test(wordBefore(state, pos));
  return false;
}

/** TypeScript: type names and type argument lists, or a generic-able declaration name. */
function tsTypePosition(state: EditorState, pos: number): boolean {
  const n = syntaxTree(state).resolveInner(pos, -1);
  const parent = n.parent;
  if (n.name === "TypeName" || n.name === "TypeArgList" || parent?.name === "TypeArgList") return true;
  if (n.name === "TypeDefinition" && parent && ["TypeParamList", "InterfaceDeclaration"].includes(parent.name))
    return true;
  // The name of a class / function declaration, `new Array<`, or a superclass.
  if (
    n.name === "VariableDefinition" &&
    parent &&
    ["ClassDeclaration", "FunctionDeclaration", "InterfaceDeclaration"].includes(parent.name)
  )
    return true;
  if (n.name === "VariableName" && parent && ["NewExpression", "ClassDeclaration"].includes(parent.name)) return true;
  return false;
}

/** Rust: type identifiers (`Vec`), a `fn` / `trait` / `struct` name, `impl<`, or a turbofish `::<`. */
function rustTypePosition(state: EditorState, pos: number): boolean {
  const n = syntaxTree(state).resolveInner(pos, -1);
  if (n.name === "TypeIdentifier" || n.name === "TypeArgList" || n.name === "GenericFunction" || n.name === "impl")
    return true;
  if (n.name === "::" && n.parent?.name === "GenericFunction") return true;
  if (n.name === "BoundIdentifier") return n.parent?.name === "FunctionItem";
  return false;
}

/**
 * Kotlin and C# use stream parsers here, whose trees are flat token lists
 * without type contexts — so the rule is the token before the caret: a type /
 * declaration identifier, capitalized as the language's types are (`List`,
 * `Box`, `fun <T>`), never a lowercase value (`a < b`).
 */
function cLikeTypePosition(state: EditorState, pos: number): boolean {
  // The token ending where the spaces and tabs before the caret start.
  const lineStart = state.doc.lineAt(pos).from;
  let end = pos;
  while (end > lineStart && /[ \t]/.test(state.sliceDoc(end - 1, end))) end--;
  const token = syntaxTree(state).resolveInner(end, -1);
  if (token.to !== end || !token.parent) return false;
  // Kotlin puts a function's type parameters right after the `fun` keyword.
  if (token.name === "keyword") return state.sliceDoc(token.from, token.to) === "fun";
  if (!/^(?:typeName|variableName)/.test(token.name)) return false;
  const name = state.sliceDoc(token.from, token.to);
  // A type, or a generic factory call written against its `<` (`mutableListOf<`, `emptyMap<`).
  return (
    /^[A-Z]/.test(name) ||
    (end === pos && /^(\w+Of|empty[A-Z]\w*|arrayOfNulls|enumValues|enumValueOf|typeOf)$/.test(name))
  );
}

/** Standard C++ templates (and casts) written against their `<`. */
const CPP_TEMPLATES = new Set([
  "vector",
  "array",
  "deque",
  "list",
  "forward_list",
  "map",
  "multimap",
  "set",
  "multiset",
  "unordered_map",
  "unordered_multimap",
  "unordered_set",
  "unordered_multiset",
  "stack",
  "queue",
  "priority_queue",
  "pair",
  "tuple",
  "optional",
  "variant",
  "any",
  "function",
  "span",
  "basic_string",
  "unique_ptr",
  "shared_ptr",
  "weak_ptr",
  "make_unique",
  "make_shared",
  "atomic",
  "future",
  "promise",
  "initializer_list",
  "numeric_limits",
  "is_same",
  "enable_if",
  "conditional",
  "decay",
  "remove_reference",
  "static_cast",
  "dynamic_cast",
  "const_cast",
  "reinterpret_cast",
  "duration_cast",
  "get",
  "hash",
  "less",
  "greater",
  "allocator",
  "reference_wrapper",
  "string_view",
  "bitset",
  "complex",
  "valarray",
]);

/** `#include <` in C and C++. */
function includePosition(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return /^\s*#\s*(include|include_next|import)\s*$/.test(line.text.slice(0, pos - line.from));
}

/**
 * C++: `#include <`, `template <`, and a template name written against its `<`: a standard one
 * (`std::vector<`, `static_cast<`) or a capitalized one (`Box<`), never a value (`a < b`, `i<n`)
 * or an all-caps macro.
 */
function cppTypePosition(state: EditorState, pos: number): boolean {
  if (includePosition(state, pos)) return true;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (/\btemplate\s*$/.test(before)) return true;
  const name = /(?:^|[^\w])(\w+)$/.exec(before)?.[1];
  if (!name || /\boperator$/.test(before)) return false;
  return CPP_TEMPLATES.has(name) || (/^[A-Z]/.test(name) && /[a-z]/.test(name));
}

const ANGLE_PAIR_RULES: Record<string, (state: EditorState, pos: number) => boolean> = {
  java: javaTypePosition,
  typescript: tsTypePosition,
  typescriptreact: tsTypePosition,
  kotlin: cLikeTypePosition,
  csharp: cLikeTypePosition,
  rust: rustTypePosition,
  c: includePosition,
  cpp: cppTypePosition,
  "objective-c": includePosition,
  "objective-cpp": cppTypePosition,
};

/** The `<>` pairs the smart angle brackets inserted; `>` steps over their closing half. */
const angleScopes = StateField.define<readonly Scope[]>({
  create: () => [],
  update(scopes, tr) {
    for (const e of tr.effects) if (e.is(leaveScopes)) scopes = scopes.filter((s) => !e.value.includes(s.to));
    if (!tr.docChanged) return scopes;
    const caret = tr.startState.selection.main.head;
    let next: Scope[] = scopes.filter((s) => {
      let keep = true;
      tr.changes.iterChangedRanges((fromA, toA) => {
        const outside = fromA < s.from || toA > s.to;
        if (outside && (caret < s.from || caret > s.to || (toA >= s.from && fromA <= s.to))) keep = false;
      });
      return keep;
    });
    next = next.map((s) => ({ from: tr.changes.mapPos(s.from, -1), to: tr.changes.mapPos(s.to, 1) }));
    return [...next, ...insertedAnglePairs(tr)];
  },
});

/** Empty scopes between the `<>` pairs a typing transaction auto-inserted. */
function insertedAnglePairs(tr: Transaction): Scope[] {
  if (!tr.isUserEvent("input.type")) return [];
  const out: Scope[] = [];
  tr.changes.iterChanges((_fa, _ta, fromB, toB, inserted) => {
    if (toB - fromB !== 2 || inserted.toString() !== "<>") return;
    const inside = fromB + 1;
    if (tr.newSelection.ranges.some((r) => r.empty && r.head === inside)) out.push({ from: inside, to: inside });
  });
  return out;
}

/**
 * Smart Keys › Insert pair bracket, for `<`: pairs it where the language's
 * rule sees a type argument list start; typing `>` steps over the inserted
 * half (Tab-out goes through `PAIRS`). No rule, no pairing.
 */
export function smartAngleBrackets(language: string | undefined): Extension {
  const isTypePosition = ANGLE_PAIR_RULES[language ?? ""];
  if (!isTypePosition) return [];
  return [
    angleScopes,
    EditorView.inputHandler.of((view, _from, _to, text) => {
      const { state } = view;
      if (state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
      if (text === "<") {
        if (!state.selection.ranges.every((r) => !inLiteral(state, r.head) && isTypePosition(state, r.head)))
          return false;
        view.dispatch(
          state.changeByRange((r) => ({
            changes: { from: r.from, to: r.to, insert: "<>" },
            range: EditorSelection.cursor(r.from + 1),
          })),
          { scrollIntoView: true, userEvent: "input.type" },
        );
        return true;
      }
      if (text === ">") {
        const scopes = state.field(angleScopes, false) ?? [];
        if (
          !state.selection.ranges.every(
            (r) => state.sliceDoc(r.head, r.head + 1) === ">" && scopes.some((s) => s.to === r.head),
          )
        )
          return false;
        view.dispatch({
          selection: EditorSelection.create(
            state.selection.ranges.map((r) => EditorSelection.cursor(r.head + 1)),
            state.selection.mainIndex,
          ),
          effects: leaveScopes.of(state.selection.ranges.map((r) => r.head)),
          scrollIntoView: true,
          userEvent: "input.type",
        });
        return true;
      }
      return false;
    }),
  ];
}

/** Languages that join string literals with `+`. */
const PLUS_CONCAT_LANGS = new Set([
  "java",
  "csharp",
  "kotlin",
  "groovy",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);

/** The one-line string literal around `pos` (parse tree, else the highlighted literals). */
function stringLiteralAt(state: EditorState, pos: number): { from: number; to: number } | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent)
    if (/^(StringLiteral|String)$/.test(n.name)) return { from: n.from, to: n.to };
  const lit = literalAt(state, pos);
  return lit?.kind === "string" ? lit : null;
}

/**
 * Enter inside a string literal splits it into two joined with `+` (`"hello" +` / `"world"`),
 * keeping the value, as in IDEA; text blocks, template literals and other languages get a plain newline.
 */
export function enterInStringLiteral(language: string): Command {
  return (view) => {
    if (!PLUS_CONCAT_LANGS.has(language)) return false;
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const pos = sel.head;
    const lit = stringLiteralAt(state, pos);
    if (!lit) return false;
    const text = state.sliceDoc(lit.from, lit.to);
    const quote = text[0];
    const singleQuoted = quote === "'" && language !== "java" && language !== "csharp" && language !== "kotlin";
    if (!(quote === '"' || singleQuoted) || text.startsWith('"""')) return false;
    // Strictly between the quotes of a literal on one line, and not inside an escape.
    if (pos <= lit.from || pos >= lit.to || !text.endsWith(quote) || text.length < 2) return false;
    if (state.doc.lineAt(lit.from).number !== state.doc.lineAt(lit.to).number) return false;
    const before = state.sliceDoc(lit.from + 1, pos);
    if (/(^|[^\\])(\\\\)*\\$/.test(before)) return false;
    // The continuation indent: two levels in the JVM languages and C#, one in JavaScript (IDEA's defaults).
    const unit = indentString(state, getIndentUnit(state));
    const base = /^\s*/.exec(state.doc.lineAt(pos).text)![0];
    const indent = base + (language.startsWith("javascript") || language.startsWith("typescript") ? unit : unit + unit);
    const insert = `${quote} +${state.lineBreak}${indent}${quote}`;
    view.dispatch({
      changes: { from: pos, insert },
      selection: { anchor: pos + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  };
}

// --- semicolon at statement end --------------------------------------------------------------

/** The paren group opens a control statement head, where `;` separates parts (`for`) or no `;` belongs. */
const CONTROL_HEAD = /\b(for|foreach|if|while|switch|catch|synchronized|try|using|lock|fixed|when)\s*$/;
/** `} while (…)` closes a do-while, which does end with `;`. */
const DO_WHILE_TAIL = /^\s*}\s*while\s*$/;
/** Comment continuation lines, preprocessor directives, annotations and attributes. */
const NOT_A_STATEMENT_LINE = /^\s*(\*|\/\/|\/\*|#|@|\[)/;
/** Syntax nodes around the `(` that make the group a parameter list or an annotation, not a call. */
const NOT_A_CALL = /Param|Annotation|Attribute|Decorator/;
const LITERAL = /string|comment|template|textblock|char|rune/i;
/** The next line goes on with the expression (a chained call, an operator), so the statement doesn't end here. */
const CONTINUES = /^\s*(\.|\?|:|&&|\|\||\+(?!\+)|-(?!-)|\*(?!\/)|\/(?![/*])|%|=|,)/;

/**
 * Where a `;` typed at `pos` goes to end the statement, as in IDEA's
 * `editor.move.semicolon.after.paren`: right after the last `)` when nothing
 * but closing parentheses and whitespace follow the caret on its line. `null`
 * (a plain `;`) in literals and comments, for / try / control heads,
 * declarations and annotations, and when the statement goes on below.
 */
function semicolonTarget(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const rest = line.text.slice(pos - line.from);
  if (!/^[\s)]*\)[\s)]*$/.test(rest)) return null;
  if (codeEnd(before, lineCommentToken(state, line.from)) !== before.length) return null;
  const tree = syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent)
    if (n.from < pos && pos < n.to && LITERAL.test(n.name)) return null;

  const target = pos + rest.lastIndexOf(")") + 1;
  const match = matchBrackets(state, target, -1);
  if (!match?.matched || !match.end) return null;
  const open = match.end.from;
  const head = state.sliceDoc(state.doc.lineAt(open).from, open);
  if (CONTROL_HEAD.test(head) && !DO_WHILE_TAIL.test(head)) return null;
  if (NOT_A_STATEMENT_LINE.test(head)) return null;
  let n: SyntaxNode | null = tree.resolveInner(open, 1);
  for (let depth = 0; n && depth < 3; n = n.parent, depth++) if (NOT_A_CALL.test(n.name)) return null;

  for (let no = line.number + 1; no <= state.doc.lines; no++) {
    const next = state.doc.line(no).text;
    if (!next.trim()) continue;
    if (CONTINUES.test(next)) return null;
    break;
  }
  return target;
}

/**
 * Settings › Smart Keys › "Move ';' typed before ')' to the end of the
 * statement": `foo(bar|)` + `;` → `foo(bar);|`, in languages that end
 * statements with `;`. When any caret doesn't qualify, every caret types a plain `;`.
 */
export function semicolonAtStatementEnd(language: string | undefined): Extension {
  if (!SEMICOLON_LANGS.has(language ?? "")) return [];
  return EditorView.inputHandler.of((view, _from, _to, text) => {
    const { state } = view;
    if (text !== ";" || state.readOnly || state.selection.ranges.some((r) => !r.empty)) return false;
    const targets = state.selection.ranges.map((r) => semicolonTarget(state, r.head));
    if (targets.some((t) => t === null) || new Set(targets).size !== targets.length) return false;
    view.dispatch(
      state.changeByRange((r) => {
        const at = semicolonTarget(state, r.head)!;
        return { changes: { from: at, insert: ";" }, range: EditorSelection.cursor(at + 1) };
      }),
      { scrollIntoView: true, userEvent: "input.type" },
    );
    return true;
  });
}

/** Whether the line before `pos` leaves a `"` or backtick string open. */
function insideQuotes(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  let open: string | null = null;
  const text = line.text.slice(0, pos - line.from);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (open) {
      if (c === "\\") i++;
      else if (c === open) open = null;
    } else if (c === '"' || c === "`" || c === "'") open = c;
  }
  return open !== null;
}

/** Languages whose string templates write `${expression}`. */
const TEMPLATE_BRACE_LANGS = new Set([
  "kotlin",
  "groovy",
  "dart",
  "scala",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);

/**
 * `{` typed right after `$` in a string pairs into `${|}` (the closing quote right after it
 * keeps `closeBrackets()` from pairing it), as IDEA does for Kotlin and JavaScript templates.
 */
export function templateBrace(language: string): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "{" || from !== to || view.state.readOnly || !TEMPLATE_BRACE_LANGS.has(language)) return false;
    const { state } = view;
    if (state.sliceDoc(from - 1, from) !== "$" || state.sliceDoc(from, from + 1) === "}") return false;
    if (literalAt(state, from - 1)?.kind !== "string" || !insideQuotes(state, from)) return false;
    view.dispatch({ changes: { from, insert: "{}" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    return true;
  });
}

/**
 * Rust: a `'` where a lifetime goes (`<'a>`, `&'a`, `T: 'a`, `+ 'static`, `<'a, 'b>`) stays single;
 * elsewhere it opens a char literal and pairs as usual.
 */
export const rustLifetimeQuote = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "'" || from !== to || view.state.readOnly) return false;
  const line = view.state.doc.lineAt(from);
  // Earlier lifetimes on the line are no quotes to count around.
  const before = line.text.slice(0, from - line.from).replace(/'[A-Za-z_]\w*\b(?!')/g, "");
  const prev = before.trimEnd().slice(-1);
  const inAngles = countOutsideStrings(before, "<") > countOutsideStrings(before, ">");
  const lifetime = prev === "<" || prev === "&" || prev === "+" || (inAngles && (prev === "," || prev === ":"));
  if (!lifetime) return false;
  view.dispatch({ changes: { from, insert: "'" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  return true;
});
