/**
 * Where a Minitest test is defined. Minitest's output names `Class#test_name` and no file for tests that
 * pass, so the tree finds the source by searching the project: the class, then the `def` in its file.
 * Spec-style tests (`describe "Thing" do it "does x"`) are reported as `Thing#test_0001_does_x`.
 */
import type { FileMatches } from "@/platform/ipc";

/** Runs a regular-expression search over the project's Ruby files, or over `files` when given. */
export type RubySearch = (pattern: string, files?: string[]) => Promise<FileMatches[]>;

export interface RubyTestSite {
  path: string;
  /** 1-based. */
  line: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SPEC_TEST = /^test_\d+_(.+)$/;

const first = (hits: FileMatches[], file?: string) => {
  const hit = file ? hits.find((h) => h.path === file) : hits[0];
  return hit?.matches[0] ? { path: hit.path, line: hit.matches[0].line + 1 } : null;
};

export async function findRubyTest(search: RubySearch, className: string, test: string): Promise<RubyTestSite | null> {
  const spec = SPEC_TEST.exec(test);
  // `Outer::InnerTest` is declared as `class InnerTest` inside `module Outer`, or as written.
  const last = className.split("::").pop()!;
  const declared = spec
    ? `^\\s*(describe|context)\\s*\\(?\\s*(["'])${escape(className)}\\2`
    : `^\\s*(class|module)\\s+([A-Z]\\w*::)*${escape(last)}\\b`;
  const owners = await search(declared);
  const files = owners.map((o) => o.path);
  const inOwners = (pattern: string) => (files.length ? search(pattern, files) : search(pattern));
  const body = spec
    ? // Spec descriptions lose their spaces to underscores in the method name.
      `^\\s*it\\s*\\(?\\s*(["'])${escape(spec[1]!).replace(/_/g, "[ _]")}\\1`
    : `^\\s*def\\s+${escape(test)}\\b`;
  const hits = await inOwners(body);
  // The same method name is common (`test_initialize`): prefer the file that declares the class.
  const site =
    first(
      hits,
      files.find((f) => hits.some((h) => h.path === f)),
    ) ?? first(hits);
  return site ?? first(owners);
}
