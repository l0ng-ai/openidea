/**
 * IDEA-style "Application" run configurations for Java / Kotlin main classes
 * (Spring Boot applications get their own kind), the module a source file
 * belongs to, and test configurations scoped to one class or method: through Maven / Gradle,
 * or for JUnit 5 in a Maven module, OpenIDEA's own runner (Settings › Maven › Run tests using).
 */
import type { RunConfig } from "@/platform/ipc";
import { CLASSPATH, JUNIT_RUNNER_MAIN, TEST_CLASSPATH, jvmModuleDir, parseJavaArgs } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";
import { isTestPath, rootFor } from "@/platform/languageSettings";
import { currentRoots } from "@/platform/projectRoots";
import { simpleClassName } from "./jvmTargets";
import { withMavenTests } from "./mavenTests";

export { jvmModuleDir } from "@/platform/javaLaunch";

/**
 * In a test source root, as IDEA's `getClasspathType` decides: the root holding the file
 * (synced from Gradle, detected or marked in Project Structure) wins; `src/test` only
 * while no root is known for the file.
 */
const isTestSource = (relPath: string) => {
  const roots = currentRoots();
  return rootFor(roots, relPath) ? isTestPath(roots, relPath) : /(^|\/)src\/test\//.test(relPath);
};

/** Temporary "Application" configuration that runs `className` (a binary name). */
export function applicationConfig(
  target: { className: string; spring?: boolean },
  relPath: string,
  configs: readonly RunConfig[] = [],
): RunConfig {
  const module = jvmModuleDir(relPath, configs);
  const id = `application:${module ? `${module}:` : ""}${target.className}`;
  // Project detection also recognises annotations carrying @SpringBootApplication.
  const spring = target.spring || configs.some((c) => c.id === id && c.kind === "spring-boot");
  return {
    id,
    name: simpleClassName(target.className),
    kind: spring ? "spring-boot" : "application",
    command: "java",
    args: ["-cp", isTestSource(relPath) ? TEST_CLASSPATH : CLASSPATH, target.className],
    cwd: null,
    module,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: relPath.endsWith(".kt") ? "kotlin-debug-adapter" : "java-debug",
  };
}

/**
 * Narrows a Maven / Gradle test configuration to a class (`method` unset) or
 * one method: Surefire `-Dtest=Class#method`, Gradle `--tests Class.method`.
 * `fileConfig` is the file-level configuration; for Gradle its last argument is the file filter.
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
        args: withMavenTests(fileConfig.args, `${className}${method ? `#${method}` : ""}`),
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

/** A JUnit test file (JUnit 5 Jupiter, JUnit 4 or JUnit 3): OpenIDEA's runner handles all of them, TestNG goes to Maven. */
const JUNIT_IMPORT = /^\s*import\s+(?:static\s+)?(?:org\.junit\.|junit\.framework\.)/m;

/** Settings › Build Tools › Maven › Run tests using: OpenIDEA (the default), not Surefire. */
export function runsJunitInIde(fileConfig: RunConfig, content: string | undefined): boolean {
  if (fileConfig.kind !== "maven" || !content || !JUNIT_IMPORT.test(content)) return false;
  return useProject.getState().settings?.languages?.java?.maven?.runTestsUsing !== "maven";
}

/**
 * A test class (`method` unset) or method run by OpenIDEA's JUnit Platform runner on the module's
 * test classpath, like IDEA's JUnit configurations: `java -ea -cp ${testClasspath} <runner> Class#method`.
 * Its working directory is the module's, as Surefire's.
 */
export function junitRunnerConfig(
  className: string,
  method: string | undefined,
  relPath: string,
  configs: readonly RunConfig[],
): RunConfig {
  const app = applicationConfig({ className }, relPath, configs);
  const selector = `${className}${method ? `#${method}` : ""}`;
  const simple = simpleClassName(className);
  return {
    ...app,
    id: `junit:${app.module ? `${app.module}:` : ""}${selector}`,
    name: method ? `${simple}.${method}` : simple,
    args: ["-ea", "-cp", TEST_CLASSPATH, JUNIT_RUNNER_MAIN, selector],
    cwd: app.module || null,
    isTest: true,
  };
}

/** A configuration run by OpenIDEA's JUnit runner (its arguments after the main class select the tests). */
export function isJunitRunner(config: Pick<RunConfig, "kind" | "args">): boolean {
  return config.kind === "application" && parseJavaArgs(config.args).mainClass === JUNIT_RUNNER_MAIN;
}
