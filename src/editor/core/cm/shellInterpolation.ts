import { type StreamParser } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type Frame<S> =
  | { kind: "string"; quote: string }
  | { kind: "code"; close: string; depth: number; base: S; parameter: boolean };

type Heredoc = { delimiter: string; stripTabs: boolean };

type State<S> = { frames: Frame<S>[]; heredocs: Heredoc[]; identifier: boolean; indentUnit: number };

/** Keep shell expansions out of the enclosing string's token. */
export function shellInterpolation<S>(base: StreamParser<S>): StreamParser<State<S>> {
  const fresh = (unit: number) => base.startState!(unit);
  const copy = (state: S): S => {
    if (base.copyState) return base.copyState(state);
    const result = { ...state };
    for (const key in result) {
      if (Array.isArray(result[key])) result[key] = result[key].slice() as S[typeof key];
    }
    return result;
  };
  return {
    name: base.name,
    languageData: base.languageData,
    tokenTable: { ...base.tokenTable, templateDelimiter: tags.special(tags.brace) },
    startState: (unit) => ({
      frames: [{ kind: "code", close: "", depth: 0, base: fresh(unit), parameter: false }],
      heredocs: [],
      identifier: false,
      indentUnit: unit,
    }),
    copyState: (state) => ({
      ...state,
      frames: state.frames.map((frame) =>
        frame.kind === "code" ? { ...frame, base: copy(frame.base) } : { ...frame },
      ),
      heredocs: state.heredocs.slice(),
    }),
    token(stream, state) {
      // Bodies start on the line after the operator, one per pending heredoc. The stock mode only ends a body on an
      // exact delimiter line, so a `<<-` body whose delimiter is tab-indented would never end.
      const heredoc = state.heredocs[0];
      if (heredoc && stream.sol()) {
        stream.skipToEnd();
        const line = heredoc.stripTabs ? stream.string.replace(/^\t+/, "") : stream.string;
        if (line === heredoc.delimiter) state.heredocs.shift();
        return "string.special";
      }
      const frame = state.frames[state.frames.length - 1]!;
      if (state.identifier) {
        state.identifier = false;
        stream.match(/^(?:[A-Za-z_][\w]*|[0-9@*#?$!_-])/);
        return "variableName";
      }
      const expansion = () => {
        const match = stream.match(/^\$(\(\(|\(|\{)/);
        if (match) {
          const open = (match as RegExpMatchArray)[1]!;
          state.frames.push({
            kind: "code",
            close: open === "{" ? "}" : open === "((" ? "))" : ")",
            depth: 0,
            base: fresh(state.indentUnit),
            parameter: open === "{",
          });
          return true;
        }
        if (stream.match(/^\$(?=[A-Za-z_0-9@*#?$!_-])/)) {
          state.identifier = true;
          return true;
        }
        return false;
      };
      if (frame.kind === "string") {
        if (frame.quote === '"' && expansion()) return "templateDelimiter";
        if (frame.quote === '"' && stream.eat("`")) {
          state.frames.push({ kind: "code", close: "`", depth: 0, base: fresh(state.indentUnit), parameter: false });
          return "templateDelimiter";
        }
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === frame.quote) {
            state.frames.pop();
            break;
          }
          if (ch === "\\" && frame.quote !== "'") {
            stream.next();
            continue;
          }
          if (
            frame.quote === '"' &&
            (stream.peek() === "`" || /^\$(?:[({A-Za-z_0-9@*#?$!_-])/.test(stream.string.slice(stream.pos)))
          )
            break;
        }
        return "string";
      }
      // Let the stock mode retain ownership of comments.
      const position = stream.pos;
      const style = base.token(stream, copy(frame.base));
      stream.pos = position;
      if (style === "comment" && !frame.parameter && frame.close !== "))") return base.token(stream, frame.base);
      // `<<` is a shift inside arithmetic, and `<<<` is a here-string.
      const operator =
        frame.close !== "))" &&
        (stream.match(/^<<(?!<)(-?)[ \t]*((?:[^\s|&;()<>'"\\]|\\.|'[^']*'|"[^"]*")*)/) as RegExpMatchArray | null);
      if (operator) {
        const delimiter = operator[2]!.replace(
          /\\(.)|'([^']*)'|"([^"]*)"/g,
          (_, escaped?: string, single?: string, double?: string) => escaped ?? single ?? double ?? "",
        );
        if (delimiter) state.heredocs.push({ delimiter, stripTabs: operator[1] === "-" });
        return "string.special";
      }
      if (frame.close && frame.depth === 0 && stream.match(frame.close)) {
        state.frames.pop();
        return "templateDelimiter";
      }
      if (expansion()) return "templateDelimiter";
      if (stream.match(/^["']/)) {
        state.frames.push({ kind: "string", quote: stream.current() });
        return "string";
      }
      if (stream.eat("`")) {
        state.frames.push({ kind: "code", close: "`", depth: 0, base: fresh(state.indentUnit), parameter: false });
        return "templateDelimiter";
      }
      if (frame.close && frame.close !== "`") {
        const opening = frame.close === "}" ? "{" : "(";
        if (stream.eat(opening)) {
          frame.depth++;
          return "punctuation";
        }
        if (frame.depth > 0 && stream.eat(frame.close[0]!)) {
          frame.depth--;
          return "punctuation";
        }
      }
      if (frame.close === "))" || frame.parameter) {
        if (stream.match(/^\d+/)) return "number";
        if (stream.match(/^[A-Za-z_]\w*/)) return "variableName";
        if (stream.eat("/") || stream.match(/^[#+*%=!:?~^&|<>-]+/)) return "operator";
      }
      return base.token(stream, frame.base);
    },
  };
}
