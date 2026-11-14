/**
 * Blade (Laravel views) editor mode: HTML outside, directives (`@if`,
 * `@include`) as keywords, and PHP inside `{{ }}`, `{!! !!}`, directive
 * arguments, `@php … @endphp` and `<?php ?>`. HTML is tokenized by the legacy
 * HTML mode on a sub-stream cut at the next Blade construct (as in `erb.ts`);
 * the PHP by a small expression tokenizer. Completion, hover and goto on the
 * PHP come from the backend (`ide_php::blade`).
 */
import { LanguageSupport, StreamLanguage, StringStream, type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** The directives `ide_php::blade::DIRECTIVES` knows; other `@words` are HTML. */
const DIRECTIVES = new Set(
  (
    "append auth aware break can canany cannot case checked choice class component componentFirst continue csrf dd " +
    "default disabled dump each else elseauth elsecan elsecanany elsecannot elseenv elseguest elseif empty endauth " +
    "endcan endcanany endcannot endcomponent endcomponentClass endempty endenv enderror endfor endforeach endforelse " +
    "endfragment endguest endif endisset endonce endPushOnce endPrependOnce endphp endprepend endproduction endpush " +
    "endpushIf endsection endsession endslot endswitch endunless endverbatim endwhile env error extends extendsFirst " +
    "for foreach forelse fragment guest hasSection if include includeFirst includeIf includeUnless includeWhen inject " +
    "isset js json lang livewire livewireScripts livewireStyles method once overwrite parent php prepend prependOnce " +
    "production props push pushIf pushOnce readonly required section sectionMissing selected session show slot stack " +
    "stop style switch unless use verbatim vite viteReactRefresh while yield"
  ).split(" "),
);

const PHP_KEYWORDS = new Set(
  (
    "abstract and array as break callable case catch class clone const continue declare default do echo else elseif " +
    "empty enum extends final finally fn for foreach function global goto if implements include instanceof insteadof " +
    "interface isset list match namespace new or print private protected public readonly require return static " +
    "switch throw trait try unset use var while xor yield"
  ).split(" "),
);
const PHP_ATOMS = new Set(["true", "false", "null", "self", "parent"]);

type Mode = "html" | "comment" | "echo" | "raw" | "tag" | "block" | "args" | "verbatim";
type State<H> = {
  html: H;
  mode: Mode;
  /** Open parentheses of directive arguments. */
  depth: number;
  /** Inside a PHP `/* … *\/` comment. */
  phpComment: boolean;
  /** The previous PHP token was `->`/`?->`/`::`: a member name follows. */
  member: boolean;
};

/** Where each PHP region ends. */
const CLOSE: Partial<Record<Mode, string>> = { echo: "}}", raw: "!!}", tag: "?>", block: "@endphp" };

function phpToken<H>(stream: StringStream, state: State<H>): string | null {
  if (state.phpComment) {
    const end = stream.string.indexOf("*/", stream.pos);
    if (end < 0) stream.skipToEnd();
    else {
      stream.pos = end + 2;
      state.phpComment = false;
    }
    return "comment";
  }
  if (stream.eatSpace()) return null;
  if (stream.match("/*")) {
    state.phpComment = true;
    return phpToken(stream, state) ?? "comment";
  }
  if (stream.match(/^(?:\/\/|#(?!\[)).*/)) return "comment";
  const member = state.member;
  state.member = false;
  if (stream.match(/^\$[A-Za-z_\x80-￿][\w\x80-￿]*/)) return "variableName";
  if (stream.match(/^'(?:[^'\\]|\\.)*'?/) || stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
  if (stream.match(/^(?:0x[0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i)) return "number";
  const word = stream.match(/^\\?[A-Za-z_\x80-￿][\w\x80-￿\\]*/);
  if (word) {
    const text = (typeof word === "object" ? word[0] : "").toLowerCase();
    if (member) return "propertyName";
    if (PHP_KEYWORDS.has(text)) return "keyword";
    if (PHP_ATOMS.has(text)) return "atom";
    return /^\s*\(/.test(stream.string.slice(stream.pos)) ? "functionName" : "typeName";
  }
  if (stream.match(/^(?:\?->|->|::)/)) {
    state.member = true;
    return "operator";
  }
  if (stream.match(/^[()[\]{},;]/)) return "punctuation";
  stream.next();
  return "operator";
}

export function bladeParser<H>(html: StreamParser<H>): StreamParser<State<H>> {
  const copy = (state: H): H =>
    html.copyState
      ? html.copyState(state)
      : (Object.fromEntries(
          Object.entries(state as object).map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]),
        ) as H);

  /** Runs `parse` on `stream` cut at `end`, then advances `stream` to where it stopped. */
  const within = (stream: StringStream, end: number, parse: (sub: StringStream) => string | null) => {
    const sub = new StringStream(stream.string.slice(0, end), 4, stream.indentUnit);
    sub.pos = stream.pos;
    sub.start = stream.start;
    const style = parse(sub);
    stream.pos = Math.max(sub.pos, stream.pos + (sub.pos === stream.pos ? 1 : 0));
    return style;
  };

  /** The next offset at or after `from` where a Blade construct may start. */
  const nextSpecial = (line: string, from: number) => {
    const found = line.slice(from).search(/\{\{|\{!!|@|<\?/);
    return found < 0 ? line.length : from + found;
  };

  const htmlToken = (stream: StringStream, state: State<H>): string | null => {
    const line = stream.string;
    const rest = line.slice(stream.pos);
    if (rest.startsWith("{{--")) {
      stream.pos += 4;
      state.mode = "comment";
      return commentToken(stream, state);
    }
    if (rest.startsWith("@{{")) {
      const close = line.indexOf("}}", stream.pos + 3);
      stream.pos = close < 0 ? line.length : close + 2;
      return null;
    }
    for (const [open, mode] of [
      ["{!!", "raw"],
      ["{{", "echo"],
      ["<?php", "tag"],
      ["<?=", "tag"],
    ] as const) {
      if (rest.startsWith(open)) {
        stream.pos += open.length;
        state.mode = mode;
        return "bladeDelimiter";
      }
    }
    const directive = /^@(@?)(\w+)/.exec(rest);
    const wordBefore = stream.pos > 0 && /\w/.test(line[stream.pos - 1]!);
    if (directive && !wordBefore && !directive[1] && DIRECTIVES.has(directive[2]!)) {
      const name = directive[2]!;
      stream.pos += directive[0].length;
      const args = /^[ \t]*\(/.test(line.slice(stream.pos));
      if (name === "php" && !args) state.mode = "block";
      else if (name === "verbatim") state.mode = "verbatim";
      else if (args) {
        state.mode = "args";
        state.depth = 0;
      }
      return "bladeDirective";
    }
    if (directive?.[1]) {
      // `@@if`: written out.
      stream.pos += directive[0].length;
      return null;
    }
    const end = nextSpecial(line, stream.pos + 1);
    return within(stream, end, (sub) => html.token(sub, state.html));
  };

  const commentToken = (stream: StringStream, state: State<H>) => {
    const close = stream.string.indexOf("--}}", stream.pos);
    if (close < 0) stream.skipToEnd();
    else {
      stream.pos = close + 4;
      state.mode = "html";
    }
    return "comment";
  };

  return {
    name: "blade",
    languageData: { ...html.languageData, commentTokens: { block: { open: "{{--", close: "--}}" } } },
    tokenTable: {
      ...html.tokenTable,
      bladeDelimiter: tags.special(tags.brace),
      bladeDirective: tags.controlKeyword,
      variableName: tags.variableName,
      propertyName: tags.propertyName,
      functionName: tags.function(tags.variableName),
      typeName: tags.typeName,
      punctuation: tags.punctuation,
    },
    startState: (indentUnit) => ({
      html: html.startState!(indentUnit),
      mode: "html",
      depth: 0,
      phpComment: false,
      member: false,
    }),
    copyState: (s) => ({ ...s, html: copy(s.html) }),
    blankLine: (s, unit) => (s.mode === "html" ? html.blankLine?.(s.html, unit) : undefined),
    indent: (s, text, cx) => (s.mode === "html" ? (html.indent?.(s.html, text, cx) ?? null) : null),
    token(stream, state) {
      const rest = stream.string.slice(stream.pos);
      switch (state.mode) {
        case "html":
          return htmlToken(stream, state);
        case "comment":
          return commentToken(stream, state);
        case "verbatim": {
          const close = stream.string.indexOf("@endverbatim", stream.pos);
          if (close === stream.pos) {
            stream.pos += "@endverbatim".length;
            state.mode = "html";
            return "bladeDirective";
          }
          return within(stream, close < 0 ? stream.string.length : close, (sub) => html.token(sub, state.html));
        }
        case "args": {
          if (!state.phpComment && rest.startsWith("(")) {
            stream.next();
            state.depth++;
            return "punctuation";
          }
          if (!state.phpComment && rest.startsWith(")")) {
            stream.next();
            if (--state.depth <= 0) state.mode = "html";
            return "punctuation";
          }
          // PHP tokens stop at parentheses, except inside strings and comments.
          return phpToken(stream, state);
        }
        default: {
          const close = CLOSE[state.mode]!;
          if (rest.startsWith(close)) {
            stream.pos += close.length;
            const block = state.mode === "block";
            state.mode = "html";
            state.phpComment = false;
            return block ? "bladeDirective" : "bladeDelimiter";
          }
          const at = rest.indexOf(close);
          return within(stream, at < 0 ? stream.string.length : stream.pos + at, (sub) => phpToken(sub, state));
        }
      }
    },
  };
}

export async function blade(): Promise<LanguageSupport> {
  const { html } = await import("@codemirror/legacy-modes/mode/xml");
  return new LanguageSupport(StreamLanguage.define(bladeParser(html)));
}
