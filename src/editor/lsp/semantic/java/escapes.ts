/**
 * Escape sequences in Java string, character and text-block literals, valid and invalid,
 * as IntelliJ's JavaStringLiteralLexer splits them (`@lezer/java` has no escape nodes).
 */
import type { Text } from "@codemirror/state";
import { Tree, TreeBuffer, type NodeSet } from "@lezer/common";
import type { SemanticRange } from "../languages";

const LITERALS = new Set(["StringLiteral", "CharacterLiteral", "TextBlock"]);
const SIMPLE = "btnfrs\"'\\";
const isOctal = (c: string | undefined) => c !== undefined && c >= "0" && c <= "7";
const isHex = (c: string | undefined) => c !== undefined && /[0-9a-fA-F]/.test(c);

/** End of the escape starting with the `\` at `i`, and whether it is valid. */
function escapeAt(text: string, i: number, textBlock: boolean): [end: number, valid: boolean] {
  const c = text[i + 1]!;
  if (SIMPLE.includes(c) || (textBlock && c === "\n")) return [i + 2, true];
  if (isOctal(c)) {
    let end = i + 2;
    if (isOctal(text[end])) end++;
    if (c <= "3" && end === i + 3 && isOctal(text[end])) end++;
    return [end, true];
  }
  if (c === "u") {
    let end = i + 2;
    while (text[end] === "u") end++;
    const digits = end;
    while (end < digits + 4 && isHex(text[end])) end++;
    return [end, end === digits + 4];
  }
  return [i + 2, false];
}

/** Appends `from, to, valid` triples (offset by `base`) for each escape of a literal's `text`. */
function scanLiteral(text: string, base: number, textBlock: boolean, out: number[]): void {
  // The closing quote(s) never start an escape; an unterminated literal's last `\` has nothing to escape.
  const last = text.length - 1;
  for (let i = text.indexOf("\\"); i >= 0 && i < last; i = text.indexOf("\\", i)) {
    const [end, valid] = escapeAt(text, i, textBlock);
    out.push(base + i, base + end, valid ? 1 : 0);
    i = end;
  }
}

const literalTypes = new WeakMap<NodeSet, Map<number, boolean>>();

/** Literal node type ids of `set`, mapped to whether they are text blocks. */
function literalsOf(set: NodeSet): Map<number, boolean> {
  let types = literalTypes.get(set);
  if (!types) {
    types = new Map(set.types.filter((t) => LITERALS.has(t.name)).map((t) => [t.id, t.name === "TextBlock"]));
    literalTypes.set(set, types);
  }
  return types;
}

/**
 * Escapes of a buffer or literal node, relative to its start. An incremental parse keeps most of the
 * old tree's nodes as they are, so after an edit only the literals on the changed path are scanned again.
 */
const cached = new WeakMap<Tree | TreeBuffer, number[]>();

function escapesOf(node: Tree | TreeBuffer, offset: number, doc: Text): number[] | null {
  let hits = cached.get(node);
  if (hits) return hits;
  if (node instanceof Tree) {
    if (!LITERALS.has(node.type.name)) return null;
    hits = [];
    scanLiteral(doc.sliceString(offset, offset + node.length), 0, node.type.name === "TextBlock", hits);
  } else {
    hits = [];
    const types = literalsOf(node.set);
    // [type, from, to, end of children] per node; `from` is relative to the buffer.
    const b = node.buffer;
    for (let i = 0; i < b.length; i += 4) {
      const textBlock = types.get(b[i]!);
      if (textBlock !== undefined)
        scanLiteral(doc.sliceString(offset + b[i + 1]!, offset + b[i + 2]!), b[i + 1]!, textBlock, hits);
    }
  }
  cached.set(node, hits);
  return hits;
}

function collect(node: Tree | TreeBuffer, offset: number, doc: Text, out: SemanticRange[]): void {
  const hits = escapesOf(node, offset, doc);
  if (!hits) {
    const tree = node as Tree;
    for (let i = 0; i < tree.children.length; i++) collect(tree.children[i]!, offset + tree.positions[i]!, doc, out);
    return;
  }
  for (let i = 0; i < hits.length; i += 3)
    out.push({
      from: offset + hits[i]!,
      to: offset + hits[i + 1]!,
      className: hits[i + 2] ? "cm-sem-escape" : "cm-sem-invalid-escape",
      source: "syntax",
    });
}

/** Escape ranges of the literals in `tree`. */
export function javaEscapeRanges(tree: Tree, doc: Text): SemanticRange[] {
  const out: SemanticRange[] = [];
  collect(tree, 0, doc, out);
  return out;
}
