/**
 * Highlighting for `.http` / `.rest` request files (registered for the
 * `HTTP` ui-mode): `###` separators, comments and `# @name`, `@var = value`,
 * request lines, headers, `{{variables}}`, `< file` includes and `> {% %}`
 * handler blocks.
 */
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

export const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

interface State {
  phase: "preamble" | "headers" | "body";
  /** Inside a `> {% … %}` handler script. */
  handler: boolean;
  json: boolean | null;
  string: "propertyName" | "string" | null;
  /** Position within the current line's structure. */
  part: "start" | "url" | "headerValue" | "rest";
}

function variable(stream: Parameters<StreamParser<State>["token"]>[0]): string | null {
  if (stream.match("{{")) {
    stream.match(/^[^}]*/);
    stream.match("}}");
    return "variableName.special";
  }
  return null;
}

export const httpParser: StreamParser<State> = {
  name: "http",
  startState: () => ({ phase: "preamble", handler: false, json: null, string: null, part: "start" }),
  copyState: (s) => ({ ...s }),
  blankLine(state) {
    if (state.phase === "headers" || (state.phase === "preamble" && state.part === "url")) state.phase = "body";
  },
  token(stream, state) {
    if (stream.sol()) {
      // The line after the request line starts the headers.
      if (state.phase === "preamble" && state.part === "url") state.phase = "headers";
      state.part = "start";
      state.string = null;
      if (stream.match(/^\s*###/)) {
        stream.skipToEnd();
        state.phase = "preamble";
        state.handler = false;
        state.json = null;
        return "heading";
      }
    }
    if (state.handler) {
      if (stream.match(/^.*%\}/)) {
        state.handler = false;
        return "meta";
      }
      stream.skipToEnd();
      return "comment";
    }
    const v = variable(stream);
    if (v) {
      if (state.phase === "preamble" && state.part === "start") state.part = "url";
      return v;
    }

    if (state.phase === "preamble") {
      if (state.part === "start") {
        if (stream.eatSpace()) return null;
        if (stream.match(/^(#|\/\/)\s*@name\b/)) {
          state.part = "rest";
          return "meta";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        if (stream.match(/^@[\w.-]+/)) {
          state.part = "rest";
          return "variableName.definition";
        }
        const method =
          stream.match(new RegExp(`^(${METHODS.join("|")})(?=\\s)`)) ||
          stream.match(/^[A-Z][A-Z0-9_-]*(?=\s+(?:[\w+.-]+:\/\/|[\w.-]+:\d+(?:[/?#]|\s|$)|\/|\{\{))/);
        if (method) {
          state.part = "url";
          return "keyword";
        }
        if (stream.match(/^(https?:\/\/|\/)/, false)) state.part = "url";
        else {
          stream.skipToEnd();
          return null;
        }
      }
      if (state.part === "url") {
        if (stream.match(/^\s+HTTP\/[\d.]+\s*$/)) return "meta";
        if (stream.eatSpace()) return null;
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      // `@name` / `@var` remainder.
      if (stream.match(/^\s*=\s*/)) return "operator";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    if (state.phase === "headers") {
      if (state.part === "start") {
        if (stream.match(/^\s+[?&/]/)) {
          state.part = "url";
          return "link";
        }
        if (stream.match(/^(#|\/\/)/)) {
          stream.skipToEnd();
          return "comment";
        }
        const contentType = /^Content-Type:\s*([^;\s]+)/i.exec(stream.string.slice(stream.pos));
        if (contentType) state.json = /(?:\/|\+)json$/i.test(contentType[1]!);
        if (stream.match(/^[^:\s]+(?=:)/)) {
          state.part = "headerValue";
          return "propertyName";
        }
        stream.skipToEnd();
        return null;
      }
      if (state.part === "url") {
        if (!stream.match(/^[^\s{]+/)) stream.next();
        return "link";
      }
      if (stream.eat(":")) return "punctuation";
      if (!stream.match(/^[^{]+/)) stream.next();
      return "string";
    }

    // Body.
    if (state.part === "start") {
      state.part = "rest";
      if (stream.match(/^\s*>\s*\{%/)) {
        state.handler = !stream.match(/^.*%\}\s*$/);
        if (!state.handler) return "meta";
        stream.skipToEnd();
        return "meta";
      }
      if (stream.match(/^\s*(<>|>>|>|<)\s/)) {
        stream.skipToEnd();
        return "meta";
      }
    }
    if (state.json === null) {
      if (stream.eatSpace()) return null;
      const start = stream.string.slice(stream.pos);
      state.json = /^(?:\[|\{\s*(?:"|}|$)|"|(?:true|false|null|-?\d[\d.eE+-]*)\s*$)/.test(start);
    }
    if (!state.json) {
      if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
      if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/)) return "number";
      if (stream.match(/^(true|false|null)\b/)) return "atom";
      if (!stream.match(/^[^"{\d\-tfn]+/)) stream.next();
      return null;
    }
    if (!state.string && stream.peek() === '"') {
      state.string = stream.match(/^"(?:[^"\\]|\\.)*"\s*:/, false) ? "propertyName" : "string";
      stream.next();
    }
    if (state.string) {
      const style = state.string;
      stream.match(/^(?:[^"\\{]|\\.|{(?!{))*/);
      if (stream.eat('"')) state.string = null;
      if (stream.pos === stream.start) stream.next();
      return style;
    }
    if (stream.match(/^[{}]/)) return "brace";
    if (stream.match(/^[[\]]/)) return "squareBracket";
    if (stream.match(/^[,:]/)) return "separator";
    if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?\b/)) return "number";
    if (stream.match(/^(true|false)\b/)) return "bool";
    if (stream.match(/^null\b/)) return "null";
    if (!stream.match(/^[^"{}[\],:\d\-tfn]+/)) stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

export const httpLanguage = StreamLanguage.define(httpParser);

export const httpLanguageDescription = LanguageDescription.of({
  name: "HTTP",
  extensions: ["http", "rest"],
  support: new LanguageSupport(httpLanguage),
});
