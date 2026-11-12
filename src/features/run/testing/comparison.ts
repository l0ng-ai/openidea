/**
 * Expected / actual values of an assertion failure, read from a test's captured
 * output, for the test tree's "Show Diff" (as in IDEA's comparison failure diff).
 */

export interface Comparison {
  expected: string;
  actual: string;
  /** Side labels when the framework doesn't say which side is expected (Rust `left` / `right`). */
  labels?: { expected: string; actual: string };
}

/** Strips the quotes / angle brackets frameworks wrap values in (`<1>`, `"a"` stays as written). */
const unwrap = (s: string) => s.trim().replace(/^<([\s\S]*)>$/, "$1");

export function parseComparison(output: readonly string[]): Comparison | null {
  // Output lines reach the parsers with ANSI escapes already stripped.
  const lines = output;
  const text = lines.join("\n");
  let m: RegExpExecArray | null;
  // JUnit / opentest4j / AssertJ / Hamcrest-style: `expected: <x> but was: <y>`.
  if ((m = /expected:\s*(<[\s\S]*?>|\S[^\n]*?)\s*but was:\s*(<[\s\S]*?>|[^\n]*)/.exec(text)))
    return { expected: unwrap(m[1]!), actual: unwrap(m[2]!) };
  // TestNG `Assert.assertEquals`: `expected [x] but found [y]`.
  if ((m = /expected \[([\s\S]*?)\] but found \[([\s\S]*?)\]/.exec(text))) return { expected: m[1]!, actual: m[2]! };
  // kotlin.test: `Expected <x>, actual <y>.`
  if ((m = /Expected <([\s\S]*?)>, actual <([\s\S]*?)>/.exec(text))) return { expected: m[1]!, actual: m[2]! };
  // Rust `assert_eq!`: `  left: x` / ` right: y` (the macro doesn't say which one is expected).
  const left = lines.findIndex((l) => /^\s*left:\s/.test(l));
  if (left >= 0 && /^\s*right:\s/.test(lines[left + 1] ?? ""))
    return {
      expected: lines[left]!.replace(/^\s*left:\s*/, ""),
      actual: lines[left + 1]!.replace(/^\s*right:\s*/, ""),
      labels: { expected: "Left", actual: "Right" },
    };
  // Jest / Vitest: `Expected: x` then `Received: y`.
  const exp = lines.findIndex((l) => /^\s*Expected:\s/.test(l));
  const rec = exp >= 0 ? lines.findIndex((l, i) => i > exp && /^\s*Received:\s/.test(l)) : -1;
  if (exp >= 0 && rec >= 0)
    return {
      expected: lines[exp]!.replace(/^\s*Expected:\s*/, ""),
      actual: lines[rec]!.replace(/^\s*Received:\s*/, ""),
    };
  // Go testify: `expected: x` then `actual  : y`.
  const gexp = lines.findIndex((l) => /^\s*(?:Error:\s+Not equal:\s*)?expected:\s/.test(l));
  const gact = gexp >= 0 ? lines.findIndex((l, i) => i > gexp && /^\s*actual\s*:\s/.test(l)) : -1;
  if (gexp >= 0 && gact >= 0)
    return {
      expected: lines[gexp]!.replace(/^.*?expected:\s*/, ""),
      actual: lines[gact]!.replace(/^\s*actual\s*:\s*/, ""),
    };
  // pytest: `assert actual == expected`.
  if ((m = /^(?:E\s+)?(?:AssertionError:\s*)?assert\s+(.+?)\s+==\s+(.+)$/m.exec(text)))
    return { expected: m[2]!.trim(), actual: m[1]!.trim() };
  return null;
}
