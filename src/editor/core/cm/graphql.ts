/**
 * GraphQL for template literals (`gql`, `graphql`), coloured as `.graphql` files' tree-sitter
 * highlighting colours them: operation and fragment names as functions, fields as properties,
 * argument names and `$variables` as variables, named types as types, enum values as
 * constants and directives as annotations.
 */
import type { StreamParser, StringStream } from "@codemirror/language";

/** What a bracket opened: a selection set, a type's fields, an enum's values, arguments, … */
type Scope = "selection" | "fields" | "values" | "arguments" | "variables" | "inputs" | "object" | "list";

interface Frame {
  scope: Scope;
  /** After `:` (or `=`) in this scope: a type or a value comes next. */
  colon: boolean;
  /** After `=`: a default value, not a type. */
  value?: boolean;
  /** For `list`: its items are types, not values. */
  types?: boolean;
}

export interface GraphQLState {
  stack: Frame[];
  /** The top-level definition being read: `type`, `enum`, `union`, `directive`, `schema` or an operation. */
  definition: string | null;
  /** What the next name is, whatever the scope. */
  next: "definition" | "type" | "spread" | "location" | null;
  inBlockString: boolean;
}

const OPERATIONS = new Set(["query", "mutation", "subscription", "fragment"]);
const TYPE_DEFINITIONS = new Set(["type", "interface", "input", "scalar", "union", "enum"]);
const KEYWORDS = new Set([...OPERATIONS, ...TYPE_DEFINITIONS, "schema", "extend", "implements", "directive", "on"]);
const VALUE_KEYWORDS = new Set(["true", "false", "null"]);
const NAME = /^[_A-Za-z][_0-9A-Za-z]*/;

function blockString(stream: StringStream, state: GraphQLState): string {
  while (!stream.eol()) {
    if (stream.match('\\"""') || stream.next() !== '"') continue;
    if (stream.match('""')) {
      state.inBlockString = false;
      break;
    }
  }
  return "string";
}

function open(state: GraphQLState, bracket: string) {
  const top = state.stack[state.stack.length - 1];
  const definition = state.definition;
  let frame: Frame;
  if (bracket === "[") frame = { scope: "list", colon: false, types: isTypePosition(state) };
  else if (bracket === "{") {
    const scope: Scope = !top
      ? definition === "enum"
        ? "values"
        : definition && definition !== "operation"
          ? "fields"
          : "selection"
      : top.colon || top.scope === "list" || top.scope === "object" || top.scope === "arguments"
        ? "object"
        : "selection";
    frame = { scope, colon: false };
  } else {
    const typeSystem = !!definition && definition !== "operation";
    const scope: Scope = typeSystem ? "inputs" : top ? "arguments" : "variables";
    frame = { scope, colon: false };
  }
  state.stack.push(frame);
  state.next = null;
}

/** Whether a name here is a type (`$id: ID`, `name: String`, `[Episode!]`). */
function isTypePosition(state: GraphQLState): boolean {
  const top = state.stack[state.stack.length - 1];
  if (!top) return false;
  if (top.scope === "list") return !!top.types;
  return top.colon && !top.value && (top.scope === "fields" || top.scope === "variables" || top.scope === "inputs");
}

/** A name, string or number was read: what follows is no longer after `:`. */
function consumed(top: Frame | undefined) {
  if (top && top.scope !== "list") top.colon = top.value = false;
}

function name(word: string, state: GraphQLState): string | null {
  const top = state.stack[state.stack.length - 1];
  const next = state.next;
  if (next === "definition") {
    state.next = null;
    return state.definition === "operation" ? "variableName.function" : "typeName";
  }
  if (next === "spread") {
    if (word === "on") {
      state.next = "type";
      return "keyword";
    }
    state.next = null;
    return "variableName.function";
  }
  if (next === "type") {
    state.next = null;
    return "typeName";
  }
  if (next === "location") {
    if (/^[A-Z_]+$/.test(word)) return "variableName.constant";
    state.next = null;
  }
  if (!top) {
    if (!KEYWORDS.has(word)) return null;
    if (OPERATIONS.has(word)) {
      state.definition = "operation";
      state.next = "definition";
    } else if (TYPE_DEFINITIONS.has(word)) {
      state.definition = word;
      state.next = "definition";
    } else if (word === "schema" || word === "directive") state.definition = word;
    else if (word === "implements") state.next = "type";
    else if (word === "on") state.next = state.definition === "directive" ? "location" : "type";
    return "keyword";
  }
  if (isTypePosition(state)) {
    consumed(top);
    return "typeName";
  }
  if (top.colon || top.scope === "list") {
    consumed(top);
    return VALUE_KEYWORDS.has(word) ? "keyword" : "variableName.constant";
  }
  switch (top.scope) {
    case "values":
      return "variableName.constant";
    case "arguments":
    case "inputs":
      return "variableName";
    default:
      return "propertyName";
  }
}

export const graphqlParser: StreamParser<GraphQLState> = {
  name: "graphql",
  startState: () => ({ stack: [], definition: null, next: null, inBlockString: false }),
  copyState: (s) => ({ ...s, stack: s.stack.map((f) => ({ ...f })) }),
  token(stream, state) {
    if (state.inBlockString) return blockString(stream, state);
    if (stream.eatSpace() || stream.eat(",")) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"""')) {
      state.inBlockString = true;
      return blockString(stream, state);
    }
    const top = state.stack[state.stack.length - 1];
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      consumed(top);
      return "string";
    }
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) {
      consumed(top);
      return "number";
    }
    if (stream.match(/^\$[_A-Za-z][_0-9A-Za-z]*/)) {
      if (top?.scope !== "variables") consumed(top);
      return "variableName";
    }
    if (stream.match(/^@[_A-Za-z][_0-9A-Za-z]*/)) return "annotation";
    if (stream.match("...")) {
      state.next = "spread";
      return "punctuation";
    }
    const word = stream.match(NAME);
    if (word) return name((word as RegExpMatchArray)[0], state);
    const ch = stream.next()!;
    if ("{([".includes(ch)) {
      open(state, ch);
      return "bracket";
    }
    if ("})]".includes(ch)) {
      state.stack.pop();
      consumed(state.stack[state.stack.length - 1]);
      if (!state.stack.length && ch === "}") state.definition = null;
      return "bracket";
    }
    // In a selection set, `alias: field` names a field after the colon too.
    if (ch === ":" && top && top.scope !== "selection") top.colon = true;
    else if (ch === "=" && top) top.colon = top.value = true;
    else if (ch === "=" && state.definition === "union") state.next = "type";
    else if ((ch === "|" || ch === "&") && !top && state.next !== "location") state.next = "type";
    return "punctuation";
  },
  languageData: { commentTokens: { line: "#" }, closeBrackets: { brackets: ["(", "[", "{", '"'] } },
};
