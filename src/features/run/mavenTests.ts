/**
 * Surefire's test selection for a Maven run. In a reactor, `-Dtest` applies to every module, and a
 * module without a matching test fails the build ("No tests matching pattern") before the module
 * that has it runs, so every selection also lets modules without matches pass.
 */
const NO_MATCH_OK = "-Dsurefire.failIfNoSpecifiedTests=false";

/** `args` running only the tests `pattern` selects (Surefire syntax), replacing an earlier selection. */
export function withMavenTests(args: readonly string[], pattern: string): string[] {
  return [...args.filter((a) => !a.startsWith("-Dtest=") && a !== NO_MATCH_OK), `-Dtest=${pattern}`, NO_MATCH_OK];
}
