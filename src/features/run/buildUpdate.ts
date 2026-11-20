import { tx } from "@/platform/i18n";
import type { JavaLaunchInfo, RunConfig } from "@/platform/ipc";
import { formatCompileErrors } from "@/platform/javaLaunch";
import { stripAnsi } from "@/ui/ansi";
import { startRun } from "./store";

const MAX_ERRORS = 10;

/**
 * A compiler error line of a Maven or Gradle build: Maven's `[ERROR] /p/A.java:[1,1] …`,
 * javac's `/p/A.java:1: error: …` and Kotlin's `e: file:///p/A.kt:1:1 …`.
 */
const COMPILE_ERROR = [
  /^\[ERROR\] .+\.(?:java|kt|groovy|scala):\[\d+,\d+\]/,
  /^.+\.(?:java|groovy|scala):\d+: error: /,
  /^e: .+\.kts?:\d+:\d+ /,
];

/** Collects the distinct compiler errors of a build's output, without colour codes; `lines()` keeps the first `MAX_ERRORS`. */
export function compileErrorCollector() {
  const errors: string[] = [];
  // Maven repeats each compiler error in its failure summary.
  const seen = new Set<string>();
  return {
    add(text: string) {
      for (const raw of text.split("\n")) {
        const line = stripAnsi(raw).trimEnd();
        if (seen.has(line) || !COMPILE_ERROR.some((re) => re.test(line))) continue;
        seen.add(line);
        if (seen.size <= MAX_ERRORS) errors.push(line);
      }
    },
    lines: () => (seen.size > MAX_ERRORS ? [...errors, `… and ${seen.size - MAX_ERRORS} more`] : errors),
  };
}

function failure(details: readonly string[]): Error {
  const title = tx("Application update build failed");
  return new Error(details.length ? `${title}\n${details.join("\n")}` : title);
}

export async function runUpdateBuild(build: RunConfig): Promise<void> {
  let finish!: (ok: boolean) => void;
  const exited = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const errors = compileErrorCollector();
  const session = await startRun(build, undefined, undefined, {
    onLine: errors.add,
    onExit: (code, stopped) => finish(code === 0 && !stopped),
  });
  if (!session || session.status === "failed" || !(await exited)) throw failure(errors.lines());
}

/** The error for an update whose Java build failed, with the compiler's errors so the user sees what to fix. */
export function updateBuildError(info: JavaLaunchInfo): Error {
  const errors = formatCompileErrors(info).trimEnd();
  return failure(errors ? errors.split("\n") : []);
}
