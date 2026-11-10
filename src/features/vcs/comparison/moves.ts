/** Conservative moved-block matching over changed line ranges. */
import type { Text } from "@codemirror/state";
import type { Chunk } from "@codemirror/merge";
import { compareWords, getInlineChunks } from "./byWord";
import { DiffTooBigError, type Range } from "./lcs";

export interface MovedBlock {
  readonly fromA: number;
  readonly toA: number;
  readonly fromB: number;
  readonly toB: number;
  readonly lineA: number;
  readonly lineB: number;
  /** Word edits relative to each moved block, ignoring indentation and whitespace. */
  readonly changes: readonly Range[];
}

interface Candidate {
  start: number;
  editEnd: number;
  row: number;
  end: number;
  text: string;
  pure: boolean;
}

interface Anchor {
  source: Candidate;
  target: Candidate;
}

interface EditedRun {
  start: number;
  from: number;
  to: number;
  text: string;
  tokens: readonly string[];
}

const meaningful = /[\p{L}\p{N}_]/u;
const declaration =
  /^(?:(?:export|default|async|public|private|protected|static)\s+)*(?:function|class|def|fn|fun|struct|interface)\b/;

function candidates(doc: Text, other: Text, chunks: readonly Chunk[], side: "a" | "b") {
  const rows = new Map<number, Candidate>();
  const unique = new Map<string, Candidate | null>();
  for (const c of chunks) {
    const [otherFrom, otherTo] = side === "a" ? [c.fromB, c.toB] : [c.fromA, c.toA];
    // A chunk may replace the empty final row when the moved block loses its final newline.
    const pure = otherFrom === otherTo || otherFrom >= other.length;
    const [from, to] = side === "a" ? [c.fromA, c.toA] : [c.fromB, c.toB];
    if (from === to || from > doc.length) continue;
    const end = doc.lineAt(Math.min(to - 1, doc.length)).number;
    const first = doc.lineAt(from).number;
    let start = first;
    let indent = Infinity;
    let block: Candidate[] = [];
    for (let row = first; row <= end; row++) {
      const raw = doc.line(row).text;
      const text = raw.trim();
      const leading = raw.length - raw.trimStart().length;
      // Keep edits from neighbouring declarations out of an approximate move.
      // Nested declarations stay with their enclosing changed block.
      if (declaration.test(text) && leading <= indent) {
        for (const line of block) line.editEnd = row - 1;
        block = [];
        start = row;
        indent = leading;
      }
      const candidate = { start, editEnd: end, row, end, text, pure };
      block.push(candidate);
      rows.set(row, candidate);
      if (meaningful.test(text)) unique.set(text, unique.has(text) ? null : candidate);
    }
  }
  return { rows, unique };
}

function editedRun(doc: Text, candidate: Candidate): EditedRun | null {
  let start = candidate.start;
  let end = candidate.editEnd;
  // Approximate matching is optional; keep its work bounded on generated or very large changes.
  if (end - start >= 256 || doc.line(end).to - doc.line(start).from > 16_384) return null;
  while (start <= end && !doc.line(start).text.trim()) start++;
  while (end >= start && !doc.line(end).text.trim()) end--;
  if (start > end) return null;
  // A shared closing brace can sit just outside a replacement hunk. Include it on both
  // sides rather than reporting the hunk boundary itself as an edit to the moved code.
  if (
    start < end &&
    declaration.test(doc.line(start).text.trim()) &&
    end < doc.lines &&
    !/^};?$/.test(doc.line(end).text.trim()) &&
    /^};?$/.test(doc.line(end + 1).text.trim())
  )
    end++;
  const from = doc.line(start).from;
  const to = doc.line(end).to;
  const text = doc.sliceString(from, to);
  const tokens = getInlineChunks(text)
    .filter((t) => !t.newline)
    .map((t) => t.key);
  return tokens.length >= 4 && tokens.length <= 2048 ? { start, from, to, text, tokens } : null;
}

function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of b) {
    const count = counts.get(token) ?? 0;
    if (count) {
      common++;
      counts.set(token, count - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/** Only score anchored, relocated runs; never compare every deletion with every insertion. */
function editedMoves(a: Text, b: Text, anchors: readonly Anchor[], crossed: ReadonlySet<number>): MovedBlock[] {
  const pairs = new Map<string, Anchor[]>();
  for (const anchor of anchors) {
    const { source, target } = anchor;
    if (source.start === target.start || (!(source.pure || target.pure) && !crossed.has(source.row))) continue;
    const key = `${source.start}:${target.start}`;
    const pair = pairs.get(key);
    if (pair) pair.push(anchor);
    else pairs.set(key, [anchor]);
    // Exhausting a budget must not turn an unexamined competitor into a confident match.
    if (pairs.size > 128) return [];
  }
  const before = new Map<number, EditedRun | null>();
  const after = new Map<number, EditedRun | null>();
  const proposals: MovedBlock[] = [];
  let budget = 65_536;
  for (const pair of pairs.values()) {
    const { source, target } = pair[0]!;
    if (!before.has(source.start)) before.set(source.start, editedRun(a, source));
    if (!after.has(target.start)) after.set(target.start, editedRun(b, target));
    const old = before.get(source.start);
    const next = after.get(target.start);
    if (!old || !next) continue;
    const sameDeclaration = pair.some(
      ({ source: s, target: t }) => s.row === old.start && t.row === next.start && declaration.test(s.text),
    );
    // One shared body line is too weak to infer that an unrelated function was renamed.
    if (!sameDeclaration && pair.length < 2) continue;
    budget -= old.tokens.length + next.tokens.length;
    if (budget < 0) return [];
    if (tokenSimilarity(old.tokens, next.tokens) < 0.75) continue;
    let changes: readonly Range[];
    try {
      changes = compareWords(old.text, next.text, "ignore");
    } catch (error) {
      if (!(error instanceof DiffTooBigError)) throw error;
      continue;
    }
    proposals.push({
      fromA: old.from,
      toA: old.to,
      fromB: next.from,
      toB: next.to,
      lineA: old.start,
      lineB: next.start,
      changes,
    });
  }
  // Both sides must identify a single counterpart; similar alternatives stay ordinary edits.
  const sources = new Map<number, number>();
  const targets = new Map<number, number>();
  for (const p of proposals) {
    sources.set(p.fromA, (sources.get(p.fromA) ?? 0) + 1);
    targets.set(p.fromB, (targets.get(p.fromB) ?? 0) + 1);
  }
  return proposals.filter((p) => p.changes.length > 0 && sources.get(p.fromA) === 1 && targets.get(p.fromB) === 1);
}

/**
 * Match unique line anchors, then extend through the surrounding changed run.
 * Ignore leading/trailing whitespace; repeated anchors and small boilerplate stay ordinary changes.
 * Each accepted line is consumed once, so large moved blocks need no pairwise search.
 */
export function findMovedBlocks(a: Text, b: Text, chunks: readonly Chunk[]): readonly MovedBlock[] {
  const before = candidates(a, b, chunks, "a");
  const after = candidates(b, a, chunks, "b");
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const anchors = [...before.unique.values()].flatMap((source) => {
    if (!source) return [];
    const target = after.unique.get(source.text);
    return target ? [{ source, target }] : [];
  });
  // In replacement chunks require crossed matches: a monotonic shift is an ordinary edit.
  const crossed = new Set<number>();
  let max = -1;
  for (const { source, target } of anchors) {
    if (target.row < max) crossed.add(source.row);
    max = Math.max(max, target.row);
  }
  let min = Infinity;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const { source, target } = anchors[i]!;
    if (target.row > min) crossed.add(source.row);
    min = Math.min(min, target.row);
  }
  const moves = editedMoves(a, b, anchors, crossed);
  for (const move of moves) {
    for (let row = move.lineA; row <= a.lineAt(move.toA).number; row++) usedA.add(row);
    for (let row = move.lineB; row <= b.lineAt(move.toB).number; row++) usedB.add(row);
  }
  for (const start of before.rows.values()) {
    if (usedA.has(start.row) || before.unique.get(start.text) !== start) continue;
    const target = after.unique.get(start.text);
    if (!target || usedB.has(target.row)) continue;
    if (start.row === target.row || (!(start.pure || target.pure) && !crossed.has(start.row))) continue;
    let lines = 0;
    let words = 0;
    let size = 0;
    while (start.row + lines <= start.end && target.row + lines <= target.end) {
      const old = before.rows.get(start.row + lines)!;
      const next = after.rows.get(target.row + lines)!;
      if (old.text !== next.text || usedA.has(old.row) || usedB.has(next.row)) break;
      if (meaningful.test(old.text)) words++;
      size += old.text.length;
      lines++;
    }
    while (lines && !before.rows.get(start.row + lines - 1)!.text) lines--;
    if (!lines || size < 16 || (words < 2 && !(declaration.test(start.text) && /\{.*\}/.test(start.text)))) continue;
    for (let i = 0; i < lines; i++) {
      usedA.add(start.row + i);
      usedB.add(target.row + i);
    }
    moves.push({
      fromA: a.line(start.row).from,
      toA: a.line(start.row + lines - 1).to,
      fromB: b.line(target.row).from,
      toB: b.line(target.row + lines - 1).to,
      lineA: start.row,
      lineB: target.row,
      changes: [],
    });
  }
  return moves;
}
