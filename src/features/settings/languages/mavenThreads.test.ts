import { expect, it } from "vitest";
import { isMavenThreadCount } from "./mavenThreads";

it("accepts the -T values Maven takes and nothing else (#4743)", () => {
  for (const ok of ["4", "1C", "2.5C", "0.5C", " 8 "]) expect(isMavenThreadCount(ok), ok).toBe(true);
  for (const bad of ["0", "0C", "-2", "2c", "2.C", ".5C", "2.5.1C", "four", "4 threads", "C"])
    expect(isMavenThreadCount(bad), bad).toBe(false);
});
