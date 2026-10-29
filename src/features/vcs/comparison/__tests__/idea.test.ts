/**
 * IntelliJ's own comparison tests (LineComparisonUtilTest,
 * WordComparisonUtilTest, SplitComparisonUtilTest; Apache-2.0, Copyright
 * JetBrains s.r.o. and contributors), converted from their Kotlin DSL into
 * `ideaCases.json`, run against the port.
 */
import { describe, expect, it } from "vitest";
import {
  compareLineFragments,
  compareLinesInner,
  compareWords,
  processBlocks,
  type ComparisonPolicy,
  type LineFragment,
  type Range,
} from "..";
import cases from "./ideaCases.json";

type Policy = "default" | "trim" | "ignore";
type Change = [number, number, number, number];

interface Case {
  source: string;
  test: string;
  type: "lines" | "lines_inner" | "words" | "splitter";
  squash: boolean;
  trim: boolean;
  before: string;
  after: string;
  changes: Partial<Record<Policy, Change[]>>;
  matchings: Partial<Record<Policy, [string, string]>>;
  policies: Policy[];
}

/** PolicyData.get: "ignore" falls back to "trim", then "default". */
const forPolicy = <T>(data: Partial<Record<Policy, T>>, policy: Policy): T | undefined =>
  policy === "ignore"
    ? (data.ignore ?? data.trim ?? data.default)
    : policy === "trim"
      ? (data.trim ?? data.default)
      : data.default;

const POLICY: Record<Policy, ComparisonPolicy> = { default: "default", trim: "trim", ignore: "ignore" };

/** Changed character offsets marked by non-space characters, '.' skipped (DiffTestCase.parseMatching). */
function parseMatching(matching: string): number[] {
  return [...matching.replace(/\./g, "")].flatMap((c, i) => (c !== " " ? [i] : []));
}

/** Changed lines: lines (split at '_' / '*') with a character other than ' ' and '_' (parseLineMatching). */
function parseLineMatching(matching: string): number[] {
  const out: number[] = [];
  let line = 0;
  let index = 0;
  while (index < matching.length) {
    let end = matching.slice(index).search(/[_*]/) + 1;
    end = end === 0 ? matching.length : index + end;
    if (/[^ _]/.test(matching.slice(index, end))) out.push(line);
    line++;
    index = end;
  }
  return out;
}

const charSets = (fragments: readonly Range[]) => {
  const s1 = new Set<number>();
  const s2 = new Set<number>();
  for (const f of fragments) {
    for (let i = f.start1; i < f.end1; i++) s1.add(i);
    for (let i = f.start2; i < f.end2; i++) s2.add(i);
  }
  return [[...s1].sort((a, b) => a - b), [...s2].sort((a, b) => a - b)];
};

const lineSets = (fragments: readonly LineFragment[]) =>
  charSets(fragments.map((f) => ({ start1: f.startLine1, end1: f.endLine1, start2: f.startLine2, end2: f.endLine2 })));

const lineChanges = (fragments: readonly LineFragment[]): Change[] =>
  fragments.map((f) => [f.startLine1, f.endLine1, f.startLine2, f.endLine2]);

const rangeChanges = (fragments: readonly Range[]): Change[] =>
  fragments.map((f) => [f.start1, f.end1, f.start2, f.end2]);

function checkWords(fragments: readonly Range[], changes?: Change[], matching?: [string, string]) {
  if (changes) expect(rangeChanges(fragments)).toEqual(changes);
  if (matching) expect(charSets(fragments)).toEqual([parseMatching(matching[0]), parseMatching(matching[1])]);
}

function run(c: Case, policy: Policy) {
  const p = POLICY[policy];
  const changes = forPolicy(c.changes, policy);
  const matching = forPolicy(c.matchings, policy);
  expect(changes ?? matching, "the case has expectations").toBeDefined();
  switch (c.type) {
    case "lines": {
      const fragments = compareLineFragments(c.before, c.after, p);
      if (changes) expect(lineChanges(fragments)).toEqual(changes);
      if (matching)
        expect(lineSets(fragments)).toEqual([parseLineMatching(matching[0]), parseLineMatching(matching[1])]);
      break;
    }
    case "lines_inner": {
      const fragments = processBlocks(compareLinesInner(c.before, c.after, p), c.before, c.after, p, true, false);
      expect(fragments).toHaveLength(1);
      const [f] = fragments;
      expect([f!.startOffset1, f!.endOffset1, f!.startOffset2, f!.endOffset2]).toEqual([
        0,
        c.before.length,
        0,
        c.after.length,
      ]);
      checkWords(f!.inner!, changes, matching);
      checkWords(compareWords(c.before, c.after, p), changes, matching);
      break;
    }
    case "words":
      checkWords(compareWords(c.before, c.after, p), changes, matching);
      break;
    case "splitter": {
      const inner = compareLinesInner(c.before, c.after, p);
      expect(lineChanges(processBlocks(inner, c.before, c.after, p, c.squash, c.trim))).toEqual(changes);
      break;
    }
  }
}

describe("IntelliJ comparison tests", () => {
  (cases as Case[]).forEach((c, i) => {
    for (const policy of new Set(c.policies))
      it(`${c.source}.${c.test} #${i} ${c.type} ${JSON.stringify(c.before)} - ${JSON.stringify(c.after)} (${policy})`, () =>
        run(c, policy));
  });
});
