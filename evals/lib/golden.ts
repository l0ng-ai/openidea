/**
 * Golden results: what a scenario found when a person last confirmed it, keyed to the
 * language server and JDK that found it. Compared as sets (recall / precision), not by order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Result group → items (e.g. `src/…/OrderBook.java:14`); repeated items count once. */
export type ResultSet = Record<string, string[]>;

export interface Golden {
  /** Tool versions the results were recorded with (`jdtls`, `java`). */
  tools: Record<string, string>;
  groups: ResultSet;
}

export interface Comparison {
  recall: number;
  precision: number;
  /** In the golden, not found (`group: item`). */
  missing: string[];
  /** Found, not in the golden. */
  extra: string[];
}

const keys = (set: ResultSet) => new Set(Object.entries(set).flatMap(([g, items]) => items.map((i) => `${g}: ${i}`)));

export function compare(found: ResultSet, golden: ResultSet): Comparison {
  const got = keys(found);
  const want = keys(golden);
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  const hit = want.size - missing.length;
  return {
    // Nothing expected and nothing found is a perfect answer.
    recall: want.size ? hit / want.size : 1,
    precision: got.size ? hit / got.size : want.size ? 0 : 1,
    missing: missing.sort(),
    extra: extra.sort(),
  };
}

export function readGolden(file: string): Golden | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Golden) : null;
}

export function writeGolden(file: string, golden: Golden) {
  mkdirSync(dirname(file), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(golden.groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([g, items]) => [g, [...new Set(items)].sort()]),
  );
  writeFileSync(file, JSON.stringify({ tools: golden.tools, groups: sorted }, null, 2) + "\n");
}

/** Tools that differ between the golden's recording and this run (`name: was → now`). */
export function toolDrift(golden: Golden, tools: Record<string, string>): string[] {
  return Object.entries(golden.tools)
    .filter(([k, v]) => tools[k] !== undefined && tools[k] !== v)
    .map(([k, v]) => `${k}: ${v} → ${tools[k]}`);
}
