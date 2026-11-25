/**
 * Surefire's test selection for a Maven run. In a reactor, `-Dtest` applies to every module, and a
 * module without a matching test fails the build ("No tests matching pattern") before the module
 * that has it runs, so every selection also lets modules without matches pass.
 * A selection is an explicit request to run those tests: it overrides `skipTests` / `maven.test.skip`
 * set as POM `<properties>` or in `.mvn/maven.config`, which would otherwise only compile. A value
 * written literally in the Surefire plugin's `<configuration>` can't be overridden from the command line.
 */
const OWN = ["-Dsurefire.failIfNoSpecifiedTests=false", "-DskipTests=false", "-Dmaven.test.skip=false"];
const replaced = (a: string) =>
  a.startsWith("-Dtest=") || /^-D(skipTests|maven\.test\.skip|surefire\.failIfNoSpecifiedTests)(=|$)/.test(a);

/** `args` running only the tests `pattern` selects (Surefire syntax), replacing an earlier selection. */
export function withMavenTests(args: readonly string[], pattern: string): string[] {
  return [...args.filter((a) => !replaced(a)), `-Dtest=${pattern}`, ...OWN];
}
