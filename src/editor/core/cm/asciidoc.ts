import { StreamLanguage, type StreamParser } from "@codemirror/language";

type State = { block: string | null };

const parser: StreamParser<State> = {
  startState: () => ({ block: null }),
  copyState: ({ block }) => ({ block }),
  token(stream, state) {
    if (stream.sol()) {
      const line = stream.string;
      const delimiter = line.trim();
      if (state.block) {
        if (delimiter === state.block) {
          state.block = null;
          stream.skipToEnd();
          return "meta";
        }
        stream.skipToEnd();
        return "monospace";
      }
      if (/^={1,6}\s+\S/.test(line)) {
        stream.skipToEnd();
        return "heading";
      }
      if (/^:[\w-]+:/.test(line)) {
        stream.skipToEnd();
        return "attributeName";
      }
      if (["----", "....", "____", "++++"].includes(delimiter)) {
        state.block = delimiter;
        stream.skipToEnd();
        return "meta";
      }
      if (/^\s*\/\//.test(line)) {
        stream.skipToEnd();
        return "comment";
      }
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^https?:\/\/[^\s[\]<>]+/)) return "link";
    if (stream.match(/^\*[^*\n]+\*/)) return "strong";
    if (stream.match(/^_[^_\n]+_/)) return "emphasis";
    if (stream.match(/^\x60[^\x60\n]+\x60/)) return "monospace";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//" } },
};

export const asciidocLanguage = StreamLanguage.define(parser);
