import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { logWarning } from "./highlight";

const LEVELS =
  "FATAL|CRITICAL|SEVERE|EMERG|ALERT|ERROR|ERR|WARNING|WARN|NOTICE|INFO|DEBUG|TRACE|VERBOSE|FINEST|FINER|FINE";
// Upper case anywhere; any case only where a level is unmistakable: `[warn]`, `<Info>`, `level=error`.
const LEVEL_UPPER = new RegExp(`^(?:${LEVELS})\\b`);
const LEVEL_MARKED = new RegExp(`^(?:${LEVELS})(?=[\\]>])`, "i");
const LEVEL_KEY = /^(?:level|lvl|severity)=/i;
const LEVEL_VALUE = new RegExp(`^(?:${LEVELS})\\b`, "i");

const TIMESTAMP = [
  /^\d{4}[-/]\d\d[-/]\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?(?:Z|[+-]\d\d(?::?\d\d)?)?)?/,
  /^\d\d:\d\d:\d\d(?:[.,]\d+)?/,
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d\d:\d\d:\d\d/,
];

const EXCEPTION = /^[\w$]+(?:\.[\w$]+)*(?:Exception|Error)\b/;
const FRAME = /^\s+(?:at\s|\.\.\. \d+ (?:more|common frames omitted))/;
const SOURCE_LOC = /^[\w./-]+\.(?:go|rs|py|java|kt|ts|tsx|js|c|cc|cpp|h|hpp|rb|cs|php):\d+\b/;
const KV_KEY = /^[a-zA-Z_][\w.-]*=/;
const QUOTED_STR = /^"(?:[^"\\]|\\.)*"/;
const BOOL_LITERAL = /^(?:true|false|null)\b/;

type State = { keyLevel: boolean };

/** Level word → the highlight tag whose colour carries its severity in every scheme. */
function levelToken(word: string): string {
  switch (word.toUpperCase()) {
    case "FATAL":
    case "CRITICAL":
    case "SEVERE":
    case "EMERG":
    case "ALERT":
    case "ERROR":
    case "ERR":
      return "invalid";
    case "WARN":
    case "WARNING":
    case "NOTICE":
      return "logWarning";
    case "INFO":
      return "string";
    default:
      return "comment";
  }
}

const parser: StreamParser<State> = {
  name: "log",
  tokenTable: { logWarning },
  startState: () => ({ keyLevel: false }),
  copyState: ({ keyLevel }) => ({ keyLevel }),
  token(stream, state) {
    if (stream.sol() && FRAME.test(stream.string)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (state.keyLevel) {
      state.keyLevel = false;
      const m = stream.match(LEVEL_VALUE) as RegExpMatchArray | null;
      if (m) return levelToken(m[0]);
    }
    if (stream.match(QUOTED_STR)) return "attributeValue";
    if (stream.match(LEVEL_KEY)) {
      state.keyLevel = true;
      return "propertyName";
    }
    const before = stream.start === 0 ? "" : stream.string[stream.start - 1]!;
    const wordStart = !/[\w$.-]/.test(before);
    if (wordStart) {
      if (stream.match(KV_KEY)) return "propertyName";
      for (const re of TIMESTAMP) if (stream.match(re)) return "number";
      const level = (stream.match(LEVEL_UPPER) || (/[[<]/.test(before) && stream.match(LEVEL_MARKED))) as
        | RegExpMatchArray
        | boolean
        | null;
      if (level) return levelToken(stream.current());
      if (stream.match(SOURCE_LOC)) return "labelName";
      if (stream.match(BOOL_LITERAL)) return "bool";
      if (stream.match(EXCEPTION)) return "typeName";
      if (stream.match(/^https?:\/\/[^\s"'<>)\]]+/)) return "link";
    }
    if (stream.match(/^[\w$]+/)) return null;
    stream.next();
    return null;
  },
};

export const logLanguage = StreamLanguage.define(parser);
