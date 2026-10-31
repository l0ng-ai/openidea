/**
 * GraphQL document assembly, like IntelliJ's `CachingGraphQLQueryLoader`: a document is
 * sent with every fragment it spreads (`...name`, where the fragment is named after its
 * file), transitively. Fragments the document defines itself are not added again.
 */
import { FRAGMENTS } from "./fragments";

interface Block {
  body: string;
  /** Fragments spread in the block and not defined in it. */
  dependencies: Set<string>;
  /** Fragments the block defines itself. */
  defines: Set<string>;
}

const FRAGMENT_DEFINITION = /^fragment\s+(\S+)\s+on\s+.*\{$/;
const SPREAD = /^\.\.\.([A-Za-z_]\w*)/;

function readBlock(text: string): Block {
  const dependencies = new Set<string>();
  const defines = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    lines.push(line);
    const def = FRAGMENT_DEFINITION.exec(line);
    if (def) defines.add(def[1]!);
    // `... on User {` is an inline fragment, not a spread.
    const spread = SPREAD.exec(line);
    if (spread) dependencies.add(spread[1]!);
  }
  for (const d of defines) dependencies.delete(d);
  return { body: lines.join("\n").trim(), dependencies, defines };
}

const fragmentBlocks = new Map<string, Block>();
const documents = new Map<string, { text: string; fragments: string[] }>();

function fragmentBlock(name: string): Block {
  let block = fragmentBlocks.get(name);
  if (!block) {
    const text = FRAGMENTS[name];
    if (text === undefined) throw new Error(`Couldn't find file for fragment ${name}`);
    block = readBlock(text);
    fragmentBlocks.set(name, block);
  }
  return block;
}

function resolve(doc: string): { text: string; fragments: string[] } {
  const cached = documents.get(doc);
  if (cached) return cached;
  const { body, dependencies, defines } = readBlock(doc);
  const found = new Map<string, Block>();
  const visit = (names: Iterable<string>) => {
    for (const name of names) {
      if (found.has(name) || defines.has(name)) continue;
      const block = fragmentBlock(name);
      found.set(name, block);
      visit(block.dependencies);
    }
  };
  visit(dependencies);
  const blocks = [...found.values()].reverse();
  const resolved = { text: [...blocks.map((f) => f.body), body].join("\n"), fragments: [...found.keys()] };
  documents.set(doc, resolved);
  return resolved;
}

/** `doc` preceded by the fragments it needs, ready to send (cached per document). */
export function withFragments(doc: string): string {
  return resolve(doc).text;
}

/** Names of the fragments `withFragments(doc)` adds, in discovery order. */
export function fragmentsOf(doc: string): string[] {
  return resolve(doc).fragments;
}
