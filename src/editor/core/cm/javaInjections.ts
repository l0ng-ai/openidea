/**
 * Embedded languages in Java annotation strings, as IntelliJ IDEA Ultimate's Spring support
 * injects them: JPQL (SQL with `nativeQuery = true`) in Spring Data JPA's `@Query`, SpEL in `@PreAuthorize`, `@Cacheable(key = …)`
 * and the like, and SpEL `#{…}` with property placeholders `${…}` in `@Value` and
 * `@ConditionalOnExpression`.
 *
 * An annotation counts only by its resolved name: written fully qualified, or by a simple name the file
 * imports (the class itself or its package with `.*`), so a project's own `@Query` keeps a plain string.
 * Escape sequences stay outside the embedded text and keep the Java string's colours.
 */
import { LanguageSupport, LRLanguage, StreamLanguage, type StringStream } from "@codemirror/language";
import { java } from "@codemirror/lang-java";
import {
  parseMixed,
  type Input,
  type NestedParse,
  type Parser,
  type SyntaxNode,
  type SyntaxNodeRef,
} from "@lezer/common";
import { SQLDialect, StandardSQL } from "@codemirror/lang-sql";

type Embedded = "SQL" | "SpEL" | "SpEL template";

const PREPOST = "org.springframework.security.access.prepost.";
const CACHE = "org.springframework.cache.annotation.";
const CACHE_ATTRIBUTES = {
  key: "SpEL",
  condition: "SpEL",
  unless: "SpEL",
} as const;

/** Annotation class → attribute → embedded language. */
const INJECTIONS: Record<string, Record<string, Embedded>> = {
  "org.springframework.data.jpa.repository.Query": {
    value: "SQL",
    countQuery: "SQL",
  },
  "org.springframework.beans.factory.annotation.Value": {
    value: "SpEL template",
  },
  "org.springframework.boot.autoconfigure.condition.ConditionalOnExpression": {
    value: "SpEL template",
  },
  [`${PREPOST}PreAuthorize`]: { value: "SpEL" },
  [`${PREPOST}PostAuthorize`]: { value: "SpEL" },
  [`${PREPOST}PreFilter`]: { value: "SpEL" },
  [`${PREPOST}PostFilter`]: { value: "SpEL" },
  [`${CACHE}Cacheable`]: CACHE_ATTRIBUTES,
  [`${CACHE}CachePut`]: CACHE_ATTRIBUTES,
  [`${CACHE}CacheEvict`]: CACHE_ATTRIBUTES,
};

const SIMPLE_NAMES = new Set(Object.keys(INJECTIONS).map((name) => name.slice(name.lastIndexOf(".") + 1)));

const text = (node: SyntaxNode, input: Input) => input.read(node.from, node.to).replace(/\s+/g, "");

/** The annotation's class: `name` as written when qualified, else the import that brings it in. */
function annotationClass(annotation: SyntaxNode, input: Input): string | null {
  const nameNode = annotation.getChild("Identifier") ?? annotation.getChild("ScopedIdentifier");
  if (!nameNode) return null;
  const name = text(nameNode, input);
  if (name.includes(".")) return name;
  if (!SIMPLE_NAMES.has(name)) return null;
  let program = annotation;
  while (program.parent) program = program.parent;
  for (const decl of program.getChildren("ImportDeclaration")) {
    if (decl.getChild("static")) continue;
    const path = decl.getChild("ScopedIdentifier");
    if (!path) continue;
    const imported = text(path, input);
    if (!decl.getChild("Asterisk")) {
      if (imported.endsWith(`.${name}`)) return imported;
    } else if (INJECTIONS[`${imported}.${name}`]) return `${imported}.${name}`;
  }
  return null;
}

/** The string literals of an attribute value: one literal, or several joined with `+`. */
function literals(value: SyntaxNode, out: SyntaxNode[] = []): SyntaxNode[] {
  if (value.name === "StringLiteral" || value.name === "TextBlock") out.push(value);
  else if (value.name === "BinaryExpression" || value.name === "ParenthesizedExpression")
    for (let child = value.firstChild; child; child = child.nextSibling) literals(child, out);
  return out;
}

const ESCAPE = /\\(?:u+[0-9a-fA-F]{4}|[0-7]{1,3}|[\s\S])/g;

/** The literal's text between its quotes, without escape sequences. */
function contentRanges(literal: SyntaxNode, input: Input, out: { from: number; to: number }[]) {
  const quote = literal.name === "TextBlock" ? 3 : 1;
  const from = literal.from + quote;
  const raw = input.read(literal.from, literal.to);
  const closed = raw.length >= 2 * quote && raw.endsWith(quote === 3 ? '"""' : '"');
  const to = closed ? literal.to - quote : literal.to;
  let start = from;
  // ponytail: an escape splits the embedded text, so `FROM\nUser` reads as `FROMUser`; rare in queries.
  for (const m of input.read(from, to).matchAll(ESCAPE)) {
    const at = from + m.index;
    if (at > start) out.push({ from: start, to: at });
    start = at + m[0].length;
  }
  if (to > start) out.push({ from: start, to });
}

const SPEL_KEYWORDS = /^(?:and|or|not|eq|ne|lt|gt|le|ge|div|mod|instanceof|matches|between|new|T)\b(?![\w$])/;

interface Frame {
  kind: "#" | "$";
  /** Inside a placeholder, past the `:` before its default value. */
  fallback: boolean;
  /** Open `{` of inline lists and maps inside a `#{…}`. */
  braces: number;
}

interface SpelState {
  /** Open `#{` / `${`. Outside them a template string is text and an expression-only string is SpEL. */
  stack: Frame[];
  /** The last token was `.` or `?.`: a property or method name follows. */
  member: boolean;
}

function spelToken(stream: StringStream, state: SpelState, template: boolean): string | null {
  if (stream.match(/^[#$]\{/)) {
    state.stack.push({
      kind: stream.current()[0] as "#" | "$",
      fallback: false,
      braces: 0,
    });
    return "meta";
  }
  const frame = state.stack[state.stack.length - 1];
  if (frame && (frame.kind === "$" || !frame.braces) && stream.eat("}")) {
    state.stack.pop();
    return "meta";
  }
  if (template && !frame) {
    if (!stream.match(/^[^#$]+/)) stream.next();
    return "string";
  }
  if (frame?.kind === "$") {
    if (frame.fallback) {
      if (!stream.match(/^[^#$}]+/)) stream.next();
      return "string";
    }
    if (stream.eat(":")) {
      frame.fallback = true;
      return "operator";
    }
    if (!stream.match(/^[^:#$}]+/)) stream.next();
    return "propertyName";
  }
  if (stream.eatSpace()) return null;
  const member = state.member;
  state.member = false;
  if (stream.eat("'")) {
    while (!stream.eol()) if (stream.next() === "'" && !stream.eat("'")) break;
    return "string";
  }
  if (stream.match(/^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[lLfFdD]?/)) return "number";
  if (stream.match(/^#\w+/)) return "variableName.standard";
  if (stream.match(/^[@&][\w$]+/)) return "meta";
  if (!member && stream.match(/^(?:true|false)\b/)) return "bool";
  if (!member && stream.match(/^null\b/)) return "null";
  if (!member && stream.match(SPEL_KEYWORDS)) return "keyword";
  if (stream.match(/^[A-Za-z_$][\w$]*/)) {
    const call = stream.match(/^\s*\(/, false);
    if (member) return call ? "propertyName.function" : "propertyName";
    return call ? "variableName.function" : "variableName";
  }
  if (stream.match(/^\??\./)) {
    state.member = true;
    return "derefOperator";
  }
  if (stream.match(/^(?:\?:|\.\?|\.\^|\.\$|[!=<>]=?|&&|\|\||[-+*/%^?:])/)) return "operator";
  if (frame && stream.match(/^[{}]/)) frame.braces += stream.current() === "{" ? 1 : -1;
  else if (!stream.match(/^[()[\]{}]/)) {
    if (stream.eat(",")) return "separator";
    stream.next();
    return null;
  }
  return "bracket";
}

function spel(template: boolean): Parser {
  return StreamLanguage.define<SpelState>({
    name: template ? "spel-template" : "spel",
    startState: () => ({ stack: [], member: false }),
    copyState: (s) => ({
      stack: s.stack.map((f) => ({ ...f })),
      member: s.member,
    }),
    token: (stream, state) => spelToken(stream, state, template),
  }).parser;
}

/** JPQL / HQL: entity names such as `User` or `Order` are not keywords, unlike in SQL. */
const JPQL_KEYWORDS =
  "select from where and or not as join left right inner outer full cross fetch on with distinct order by group " +
  "having asc desc nulls first last in like escape between is null empty member of exists all any some case when " +
  "then else end new update set delete insert into union intersect except true false count sum avg min max upper " +
  "lower trim leading trailing both length locate abs sqrt mod size index key value entry treat type coalesce " +
  "nullif concat substring cast extract function current_date current_time current_timestamp object limit offset";

let parsers: Record<Embedded | "JPQL", Parser> | null = null;

/** Whether `@Query(…)` has `nativeQuery = true`. */
function nativeQuery(args: SyntaxNode, input: Input): boolean {
  return args
    .getChildren("ElementValuePair")
    .some((pair) => /^nativeQuery\s*=\s*true$/.test(input.read(pair.from, pair.to)));
}

/** The nested parse for an annotation attribute value (`ElementValuePair`) or a lone value. */
export function javaInjection() {
  return (ref: SyntaxNodeRef, input: Input): NestedParse | null => {
    // Called for every node on each parse: rule out the rest before materializing the node.
    if (ref.name !== "ElementValuePair" && ref.name !== "AnnotationArgumentList") return null;
    const node = ref.node;
    let attribute: string;
    let value: SyntaxNode | null;
    let annotation: SyntaxNode | null;
    if (node.name === "ElementValuePair") {
      const name = node.getChild("Identifier");
      attribute = name ? input.read(name.from, name.to) : "";
      value = node.lastChild;
      annotation = node.parent?.parent ?? null;
    } else {
      // `@Ann("…")`: the value attribute's shorthand.
      attribute = "value";
      value = node.firstChild?.nextSibling ?? null;
      if (value?.name === "ElementValuePair") return null;
      annotation = node.parent;
    }
    if (!value || annotation?.name !== "Annotation") return null;
    const cls = annotationClass(annotation, input);
    const language = cls ? INJECTIONS[cls]?.[attribute] : undefined;
    if (!language) return null;
    const overlay: { from: number; to: number }[] = [];
    for (const literal of literals(value)) contentRanges(literal, input, overlay);
    if (!overlay.length) return null;
    parsers ??= {
      SQL: StandardSQL.language.parser,
      JPQL: SQLDialect.define({ keywords: JPQL_KEYWORDS, types: "", builtin: "" }).language.parser,
      SpEL: spel(false),
      "SpEL template": spel(true),
    };
    // ponytail: the mount is per attribute, so toggling `nativeQuery` restyles the query once it is edited.
    const jpql = language === "SQL" && !nativeQuery(annotation.getChild("AnnotationArgumentList")!, input);
    return { parser: parsers[jpql ? "JPQL" : language], overlay };
  };
}

/** `java()` that also parses the embedded languages of Spring annotation strings. */
export function javaWithInjections(): LanguageSupport {
  const base = java();
  const language = (base.language as LRLanguage).configure({
    wrap: parseMixed(javaInjection()),
  });
  return new LanguageSupport(language, base.support);
}
