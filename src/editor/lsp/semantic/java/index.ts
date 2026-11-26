import type { Tree } from "@lezer/common";
import type { Text } from "@codemirror/state";
import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";
import { javaDeclarationRanges } from "./declarations";
import { javaEscapeRanges } from "./escapes";
import { isReassignedAt } from "./reassigned";
import { javaUnterminatedLiteralRanges } from "./unterminated";

const TYPE_TOKENS = new Set(["class", "interface", "enum", "record", "annotation", "type", "typeParameter"]);

/** Contextual keywords `@lezer/java` parses as their own nodes but leaves uncoloured (`var` is coloured, but jdtls sends it as a type). */
const KEYWORD_NODES = new Set(["sealed", "permits", "record", "var"]);
const NAME_NODES = new Set(["Identifier", "Definition", "TypeName"]);
// What can follow `yield` when it names a variable: assignment, member access, an operand separator.
const NOT_YIELD_STATEMENT = /^\s*(?:[=.[;,)]|\+\+|--|[-+*/%&|^]=|<<=|>>>?=)/;
// A `case` label whose pattern ends here (a binding name or a record pattern's `)`): what follows is its guard.
const PATTERN_LABEL = /\bcase\s[^;{}]*[\w$)]\s*$/;

const keyword = (from: number, to: number): SemanticRange => ({
  from,
  to,
  className: "cm-sem-keyword",
  source: "syntax",
});

const wordAt = (doc: Text, from: number, word: string) =>
  doc.sliceString(from, from + word.length) === word &&
  !/^[\w$]/.test(doc.sliceString(from + word.length, from + word.length + 1));

/**
 * IntelliJ colours Java's contextual keywords as keywords. `yield` and `when` are identifiers to `@lezer/java`
 * (which doesn't parse switch rules or guards), so they are recognised from the surrounding text.
 */
export function javaKeywordRanges(tree: Tree, doc: Text): SemanticRange[] {
  const out: SemanticRange[] = [];
  const seen = new Set<number>();
  tree.iterate({
    enter(node) {
      if (KEYWORD_NODES.has(node.name)) {
        // `non-sealed` is one keyword; `@lezer/java` has nodes for `non` and `sealed` only.
        const nonSealed = node.name === "sealed" && doc.sliceString(Math.max(0, node.from - 4), node.from) === "non-";
        out.push(keyword(nonSealed ? node.from - 4 : node.from, node.to));
      } else if (NAME_NODES.has(node.name) && !seen.has(node.from)) {
        seen.add(node.from);
        const at = node.from;
        // Text heuristics: a `yield` after a comment is missed. A grammar that parses Java 21 would replace them.
        if (wordAt(doc, at, "yield")) {
          const before = doc.sliceString(Math.max(0, at - 200), at).trimEnd();
          if (/[;{}:]$|^$/.test(before) && !NOT_YIELD_STATEMENT.test(doc.sliceString(at + 5, at + 9)))
            out.push(keyword(at, at + 5));
        } else if (wordAt(doc, at, "when") && PATTERN_LABEL.test(doc.sliceString(Math.max(0, at - 300), at))) {
          out.push(keyword(at, at + 4));
        }
      }
    },
  });
  return out;
}

const javaSemantics: LanguageSemantics = {
  syntaxRanges: (tree, doc) => [
    ...javaKeywordRanges(tree, doc),
    ...javaEscapeRanges(tree, doc),
    ...javaUnterminatedLiteralRanges(tree, doc),
  ],
  fallbackRanges: (tree) => javaDeclarationRanges(tree),
  tokenClasses({ type, classes, from, doc, tree }) {
    // Relies on jdtls sending only contextual keywords (`sealed`, `permits`, `record`, `non-sealed`) as `modifier` tokens.
    if (type === "modifier" || type === "keyword") classes.push("cm-sem-keyword");
    // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
    // Nested types are `static` in Java, but IntelliJ italicises only static members, never type names.
    if (TYPE_TOKENS.has(type)) {
      const s = classes.indexOf("cm-sem-static");
      if (s >= 0) classes.splice(s, 1);
    }
    if (tree && isReassignedAt(tree, doc, from)) classes.push("cm-sem-mutable");
  },
};

registerLanguageSemantics("java", javaSemantics);
