/**
 * `.properties`, `.ini`, `.env` and Godot resources, coloured like IntelliJ's Properties and
 * DotEnv highlighters: the key is KEYWORD, the first `=` or `:` is OPERATION_SIGN and the rest
 * of the line (with its continuation lines) is STRING. The legacy mode finds the parts; its
 * own `def` and `quote` styles would read as a variable and plain text.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";

/** The legacy state with the one field read here, plus the line's separator. */
interface State {
  nextMultiline: boolean;
  separated: boolean;
}

const parser: StreamParser<State> = {
  name: properties.name,
  startState: (indentUnit) => ({ ...(properties.startState!(indentUnit) as State), separated: false }),
  // CodeMirror skips `token` on empty lines; a blank line ends a continued value.
  blankLine(state) {
    state.nextMultiline = false;
  },
  token(stream, state) {
    if (stream.sol() && !state.nextMultiline) state.separated = false;
    const style = properties.token(stream, state);
    if (style === "def") return "keyword";
    if (style === "quote") return "string";
    // The legacy mode returns null only for `=` and `:`.
    if (style === null) {
      if (state.separated) return "string";
      state.separated = true;
      return "operator";
    }
    return style;
  },
};

export const propertiesLanguage = StreamLanguage.define(parser);
