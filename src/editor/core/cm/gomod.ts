import { StreamLanguage, type StreamParser } from "@codemirror/language";

/** go.mod and go.work directives (`tool` since Go 1.24, `ignore` since Go 1.25). */
const KEYWORDS = new Set([
  "module",
  "go",
  "toolchain",
  "godebug",
  "require",
  "replace",
  "exclude",
  "retract",
  "tool",
  "ignore",
  "use",
]);

export interface GoModState {
  currentKeyword: string | null;
  inBlock: boolean;
  expectVersion: boolean;
}

export function initialGoModState(): GoModState {
  return {
    currentKeyword: null,
    inBlock: false,
    expectVersion: false,
  };
}

export const goModParser: StreamParser<GoModState> = {
  name: "gomod",
  startState: () => initialGoModState(),
  token(stream, state) {
    if (stream.eatSpace()) return null;

    if (stream.sol()) {
      if (!state.inBlock) {
        state.currentKeyword = null;
      }
      state.expectVersion = false;
    }

    // Comment
    if (stream.match(/^\/\/.*/)) {
      return "comment";
    }

    // Punctuation & operators
    if (stream.match(/^=>/)) {
      state.expectVersion = false;
      return "operator";
    }
    if (stream.eat("(")) {
      state.inBlock = true;
      return "paren";
    }
    if (stream.eat(")")) {
      state.inBlock = false;
      state.currentKeyword = null;
      return "paren";
    }

    // String literals
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
      return "string";
    }
    if (stream.match(/^`[^`]*`/)) {
      return "string";
    }

    // Check words/tokens
    const wordMatch = stream.match(/^[^\s()]+/) as RegExpMatchArray | null;
    if (!wordMatch) {
      stream.next();
      return null;
    }

    const token = wordMatch[0] ?? "";

    // Keyword at start of statement (not expecting a version)
    if (!state.expectVersion && KEYWORDS.has(token)) {
      state.currentKeyword = token;
      return "keyword";
    }

    // Semantic versions: v1.2.3, 1.22, 1.22.0, v0.0.0-2023..., v4.4.0+incompatible
    const isVersion = /^v?[0-9]+(\.[0-9]+)*([+-][a-zA-Z0-9_.-]+)*$/.test(token) || /^\[v?[0-9]+.*\]$/.test(token);

    if (isVersion) {
      state.expectVersion = false;
      return "number";
    }

    // In require/replace/use block or following module/require keyword:
    // The first token is the module path/package name (string in GoLand: green)
    if (state.currentKeyword) {
      state.expectVersion = true;
      return "string";
    }

    return null;
  },
  languageData: {
    commentTokens: { line: "//" },
    indentOnInput: /^\s*\)\s*$/,
  },
};

export const goModLanguage = StreamLanguage.define(goModParser);
