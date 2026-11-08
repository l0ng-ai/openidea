import { ChangeSet, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";

const LANGUAGES = new Set(["java", "kotlin", "javascript", "typescript", "python", "rust", "go", "c", "cpp"]);
const JS = new Set(["javascript", "typescript"]);

interface PlainString {
  quote: string;
  language: string;
}

function readEscape(text: string, at: number, language: string): { end: number; value: string } {
  const rest = text.slice(at + 1);
  const ch = rest[0];
  const basic: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
  if (language !== "rust") basic.b = "\b";
  if (!["kotlin", "rust"].includes(language)) basic.f = "\f";
  if (["python", "go", "c", "cpp"].includes(language)) basic.a = "\x07";
  if (!["java", "kotlin", "rust"].includes(language)) basic.v = "\v";
  if (language === "kotlin") basic.$ = "$";
  if (language === "java") basic.s = " ";
  if (language === "c" || language === "cpp") basic["?"] = "?";
  if (ch && basic[ch] !== undefined) return { end: at + 2, value: basic[ch] };
  let numeric: RegExpExecArray | null = null;
  let radix = 16;
  if (ch === "u") {
    if (language === "rust") numeric = /^u\{([\da-fA-F][\da-fA-F_]{0,6})\}/.exec(rest);
    else if (JS.has(language)) numeric = /^u\{([\da-fA-F]+)\}/.exec(rest);
    if (!numeric && language !== "rust")
      numeric = (language === "java" ? /^u+([\da-fA-F]{4})/ : /^u([\da-fA-F]{4})/).exec(rest);
  } else if (ch === "U" && ["python", "go", "c", "cpp"].includes(language)) {
    numeric = /^U([\da-fA-F]{8})/.exec(rest);
  } else if (ch === "x" && !["java", "kotlin"].includes(language)) {
    numeric = (language === "c" || language === "cpp" ? /^x([\da-fA-F]+)/ : /^x([\da-fA-F]{2})/).exec(rest);
  } else if (ch && /[0-7]/.test(ch)) {
    radix = 8;
    if (["python", "c", "cpp"].includes(language)) numeric = /^([0-7]{1,3})/.exec(rest);
    else if (language === "java") numeric = /^([0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(rest);
    else if (language === "go") numeric = /^([0-7]{3})/.exec(rest);
    else if (ch === "0" && (language === "rust" || (JS.has(language) && !/\d/.test(rest[1] ?? ""))))
      return { end: at + 2, value: "\0" };
  }
  if (numeric) {
    const value = Number.parseInt(numeric[1]!.replaceAll("_", ""), radix);
    const scalar = !(value >= 0xd800 && value <= 0xdfff);
    const valid =
      value <= 0x10ffff &&
      (!(language === "rust" || language === "go") || scalar) &&
      !(language === "rust" && ch === "x" && value > 0x7f) &&
      !(language === "go" && radix === 8 && value > 0xff);
    if (valid) return { end: at + 1 + numeric[0].length, value: String.fromCodePoint(value) };
  }
  if (ch === "\n" && !["java", "kotlin", "go"].includes(language)) {
    const whitespace = language === "rust" ? /^\n\s*/.exec(rest)![0] : "\n";
    return { end: at + 1 + whitespace.length, value: "" };
  }
  const end = Math.min(at + 2, text.length);
  return { end, value: text.slice(at, end) };
}

function plainStringAt(state: EditorState, from: number, to: number, language: string): PlainString | null {
  const tree = ensureSyntaxTree(state, to, 50);
  if (!tree) return null;
  for (let node = tree.resolveInner(from, 1); ;) {
    if (["String", "StringLiteral", "string"].includes(node.name)) {
      const text = state.sliceDoc(node.from, node.to);
      const quote = text[0];
      if (
        (quote !== '"' && !(quote === "'" && (JS.has(language) || language === "python"))) ||
        text.length < 2 ||
        text.at(-1) !== quote ||
        text.startsWith(quote.repeat(3)) ||
        from < node.from + 1 ||
        to > node.to - 1
      )
        return null;
      // Stream modes may merge adjacent tokens. Only accept one complete literal,
      // and never split an existing escape sequence at either selection boundary.
      for (let i = 1; i < text.length - 1; i++) {
        if (text[i] === quote) return null;
        if (text[i] !== "\\") continue;
        const { end } = readEscape(text, i, language);
        if (end > text.length - 1) return null;
        if ([from, to].some((pos) => pos > node.from + i && pos < node.from + end)) return null;
        i = end - 1;
      }
      return { quote, language };
    }
    if (!node.parent) return null;
    node = node.parent;
  }
}

function escapeText(text: string, literal: PlainString): string {
  // oxlint-disable-next-line no-control-regex -- pasted control characters need literal escapes
  return text.replace(/[\\"'\n\r\t\x00-\x1f\u2028\u2029$]/g, (ch) => {
    if (ch === "\\" || ch === literal.quote || (ch === "$" && literal.language === "kotlin")) return `\\${ch}`;
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    const code = ch.charCodeAt(0);
    if (code < 32 || (JS.has(literal.language) && code >= 0x2028)) {
      if (literal.language === "rust") return `\\u{${code.toString(16)}}`;
      if (literal.language === "c" || literal.language === "cpp") return `\\${code.toString(8).padStart(3, "0")}`;
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    return ch;
  });
}

function unescapeText(text: string, language: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") out += text[i];
    else {
      const escape = readEscape(text, i, language);
      out += escape.value;
      i = escape.end - 1;
    }
  }
  return out;
}

export function stringClipboard(language: string | undefined): Extension {
  if (!language || !LANGUAGES.has(language)) return [];
  return [
    // Transaction filters run in reverse precedence: escape before paste reindentation.
    Prec.lowest(
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || !tr.isUserEvent("input.paste") || tr.startState.readOnly) return tr;
        const state = tr.startState;
        const literals = state.selection.ranges.map((r) => plainStringAt(state, r.from, r.to, language));
        if (literals.some((literal) => !literal)) return tr;
        const corrections: { from: number; to: number; insert: string }[] = [];
        let valid = true;
        tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
          const index = state.selection.ranges.findIndex((r) => r.from === from && r.to === to);
          if (index < 0) {
            valid = false;
            return;
          }
          const text = inserted.toString();
          const escaped = escapeText(text, literals[index]!);
          if (escaped !== text) corrections.push({ from: fromB, to: toB, insert: escaped });
        });
        if (!valid || !corrections.length) return tr;
        const changes = ChangeSet.of(corrections, tr.newDoc.length, state.lineBreak);
        return [tr, { changes, selection: tr.newSelection.map(changes, 1), sequential: true }];
      }),
    ),
    EditorView.clipboardOutputFilter.of((text, state) => {
      const ranges = state.selection.ranges;
      if (ranges.some((r) => r.empty || !plainStringAt(state, r.from, r.to, language))) return text;
      const selected = ranges.map((r) => state.sliceDoc(r.from, r.to));
      if (text !== selected.join(state.lineBreak)) return text;
      return selected.map((part) => unescapeText(part, language)).join(state.lineBreak);
    }),
  ];
}
