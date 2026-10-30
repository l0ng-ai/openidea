/**
 * IDEA-style "Application" run configurations for Java / Kotlin main classes
 * (Spring Boot applications get their own kind), the module a source file
 * belongs to, and test configurations scoped to one class or method.
 */
import type { RunConfig } from "@/platform/ipc";
import { CLASSPATH, TEST_CLASSPATH } from "@/platform/javaLaunch";
import { isTestPath } from "@/platform/languageSettings";
import { currentRoots } from "@/platform/projectRoots";
import { simpleClassName } from "./jvmTargets";

/**
 * Module directory (relative to the project root, `""` for the root) of a JVM
 * source file: the part before `src/{main,test}/…`, else the working directory
 * of the closest Maven / Gradle configuration.
 */
export function jvmModuleDir(relPath: string, configs: readonly RunConfig[] = []): string {
  const m = /^(?:(.*)\/)?src\/(?:main|test|[\w-]+)\/(?:java|kotlin|scala|groovy)\//.exec(relPath);
  if (m) return m[1] ?? "";
  const cwds = configs
    .filter((c) => c.kind === "maven" || c.kind === "gradle")
    .map((c) => (c.cwd ?? "").replace(/^\.\/?/, "").replace(/\/+$/, ""))
    .filter((cwd) => !cwd || relPath.startsWith(cwd + "/"))
    .sort((a, b) => b.length - a.length);
  return cwds[0] ?? "";
}

/** In a test source root (detected or marked in Project Structure), or Maven's `src/test`. */
const isTestSource = (relPath: string) => /(^|\/)src\/test\//.test(relPath) || isTestPath(currentRoots(), relPath);

/** Temporary "Application" configuration that runs `className` (a binary name). */
export function applicationConfig(
  target: { className: string; spring?: boolean },
  relPath: string,
  configs: readonly RunConfig[] = [],
): RunConfig {
  const module = jvmModuleDir(relPath, configs);
  return {
    id: `application:${module ? `${module}:` : ""}${target.className}`,
    name: simpleClassName(target.className),
    kind: target.spring ? "spring-boot" : "application",
    command: "java",
    args: ["-cp", isTestSource(relPath) ? TEST_CLASSPATH : CLASSPATH, target.className],
    cwd: module || null,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: relPath.endsWith(".kt") ? "kotlin-debug-adapter" : "java-debug",
  };
}

/**
 * Narrows a Maven / Gradle test configuration to a class (`method` unset) or
 * one method: Surefire `-Dtest=Class#method`, Gradle `--tests Class.method`.
 * `fileConfig` is the file-level configuration whose last argument is the file filter.
 */
export function jvmTestConfig(fileConfig: RunConfig, className: string, method: string | undefined): RunConfig | null {
  const args = fileConfig.args.slice(0, -1);
  const simple = simpleClassName(className);
  const name = method ? `${simple}.${method}` : simple;
  const id = `context:target:${fileConfig.id}:${className}${method ? `#${method}` : ""}`;
  switch (fileConfig.kind) {
    case "maven":
      return {
        ...fileConfig,
        id,
        name,
        env: { ...fileConfig.env },
        args: [...args, `-Dtest=${className}${method ? `#${method}` : ""}`, "-Dsurefire.failIfNoSpecifiedTests=false"],
      };
    case "gradle":
      return {
        ...fileConfig,
        id,
        name,
        env: { ...fileConfig.env },
        args: [
          ...(args[args.length - 1] === "--tests" ? args.slice(0, -1) : args),
          "--tests",
          method ? `${className}.${method}` : className,
        ],
      };
  }
  return null;
}
