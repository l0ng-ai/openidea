/**
 * Java "Application" run configurations, shared by Run and Debug: the command
 * line is `java [vm options] -cp ${classpath} <main class> [program args]`;
 * `${classpath}` (or `${testClasspath}`) and the `java` launcher are resolved
 * through jdtls when the configuration starts.
 */
import type { JavaLaunchInfo, RunConfig } from "@/platform/ipc";

export const CLASSPATH = "${classpath}";
export const TEST_CLASSPATH = "${testClasspath}";
/** Run configuration kinds launched as a JVM main class. */
export const JVM_APPLICATION_KINDS = ["application", "spring-boot"];

export function isJvmApplication(config: Pick<RunConfig, "kind">): boolean {
  return JVM_APPLICATION_KINDS.includes(config.kind);
}

/** `java` options whose value is the next argument. */
const WITH_VALUE = new Set([
  "-cp",
  "-classpath",
  "--class-path",
  "-p",
  "--module-path",
  "--upgrade-module-path",
  "--add-modules",
  "--add-opens",
  "--add-exports",
  "--add-reads",
  "--patch-module",
  "--limit-modules",
  "--enable-native-access",
]);

export interface JavaCommandLine {
  /** VM options, without the classpath. */
  vmArgs: string[];
  mainClass: string | null;
  programArgs: string[];
  /** Which classpath placeholder the configuration uses (`null`: an explicit classpath or none). */
  classpath: "runtime" | "test" | null;
  /** An explicit `-cp` value other than a placeholder. */
  explicitClasspath: string | null;
}

/** Splits `java` arguments into VM options, main class and program arguments. */
export function parseJavaArgs(args: readonly string[]): JavaCommandLine {
  const vmArgs: string[] = [];
  let classpath: JavaCommandLine["classpath"] = null;
  let explicitClasspath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-cp" || a === "-classpath" || a === "--class-path") {
      const value = args[++i] ?? "";
      if (value === CLASSPATH) classpath = "runtime";
      else if (value === TEST_CLASSPATH) classpath = "test";
      else explicitClasspath = value;
      continue;
    }
    if (WITH_VALUE.has(a)) {
      vmArgs.push(a, args[++i] ?? "");
      continue;
    }
    if (a.startsWith("-")) {
      vmArgs.push(a);
      continue;
    }
    return { vmArgs, mainClass: a, programArgs: args.slice(i + 1), classpath, explicitClasspath };
  }
  return { vmArgs, mainClass: null, programArgs: [], classpath, explicitClasspath };
}

/** The configuration with its placeholders and launcher resolved. */
export function resolveJavaCommand(config: RunConfig, info: JavaLaunchInfo, pathSeparator = ":"): RunConfig {
  const cp = info.classPaths.join(pathSeparator);
  const args: string[] = [];
  if (info.modulePaths.length && !config.args.some((a) => a === "-p" || a === "--module-path"))
    args.push("--module-path", info.modulePaths.join(pathSeparator));
  args.push(...config.args.map((a) => (a === CLASSPATH || a === TEST_CLASSPATH ? cp : a)));
  const command = config.command === "java" && info.javaExec ? info.javaExec : config.command;
  return { ...config, command, args };
}

/** Console report of a launch's compile errors (`path:line:col: error: …`) and their likely causes; "" when none. */
export function formatCompileErrors(info: JavaLaunchInfo): string {
  const lines = info.errors.map((e) => `${e.path}:${e.line}:${e.column}: error: ${e.message}`);
  const more = info.errorCount - info.errors.length;
  if (more > 0) lines.push(`… and ${more} more error${more === 1 ? "" : "s"} (see the Problems tool window)`);
  lines.push(...info.hints);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Joins arguments into one string for adapters that take `args` / `vmArgs` as text (java-debug). */
export function joinJavaArgs(args: readonly string[]): string {
  return args.map((a) => (a === "" ? '""' : /[\s"]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

/** JDWP agent options: listen on a free local port and wait for the debugger. */
export const JDWP_AGENT = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0";

/** The port of `Listening for transport dt_socket at address: 5005` (JDWP's start-up line). */
export function jdwpListeningPort(line: string): number | null {
  const m = /Listening for transport dt_socket at address:\s*(?:[\w.[\]:-]*:)?(\d+)\s*$/.exec(line.trim());
  return m ? Number(m[1]) : null;
}
