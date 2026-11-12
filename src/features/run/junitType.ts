/**
 * JUnit: tests of a module (all, a package, a class, a method or a pattern), run through the
 * module's Maven or Gradle build exactly like the gutter's Run on a test. The command line is the
 * build's own, so test results, Debug and Rerun Failed Tests work as for those runs.
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { jvmTestConfig } from "./application";
import { testBasesFor, testConfigFor } from "./context";
import {
  ROOT_MODULE,
  buildModuleOptions,
  gradleForkedJvm,
  joinPropertyArgs,
  splitJvmArgs,
  vmOptionsField,
} from "./jvmTypes";
import { useRun } from "./store";

type TestKind = "all" | "package" | "class" | "method" | "pattern";

const kindOf = (p: Readonly<Record<string, string>>): TestKind => (p.testKind as TestKind) || "class";
const moduleDir = (p: Readonly<Record<string, string>>) => (p.module && p.module !== ROOT_MODULE ? p.module : "");
const inModule = (p: Readonly<Record<string, string>>, rel: string) => [moduleDir(p), rel].filter(Boolean).join("/");

/** The module's detected Maven / Gradle test configuration. */
function baseFor(p: Readonly<Record<string, string>>, configs: RunConfig[]): RunConfig | null {
  return (
    testBasesFor(inModule(p, "src/test/java/Test.java"), configs).find(
      (c) => c.kind === "maven" || c.kind === "gradle",
    ) ?? null
  );
}

/** The build's command line for `p`, from the project's detected test configurations. */
export function junitCommandLine(
  p: Readonly<Record<string, string>>,
  configs: RunConfig[],
): { command: string; args: string[]; cwd: string | null } {
  const base = baseFor(p, configs);
  if (!base) return { command: "", args: [], cwd: null };
  const maven = base.kind === "maven";
  const select = (pattern: string): string[] =>
    maven ? [`-Dtest=${pattern}`, "-Dsurefire.failIfNoSpecifiedTests=false"] : ["--tests", pattern];
  let args = [...base.args];
  const cls = p.className?.trim() ?? "";
  switch (kindOf(p)) {
    case "class":
    case "method": {
      if (!cls) break;
      const method = kindOf(p) === "method" ? p.methodName?.trim() || undefined : undefined;
      const file = testConfigFor(inModule(p, `src/test/java/${cls.replace(/\./g, "/")}.java`), configs, base);
      const narrowed = file && jvmTestConfig(file, cls, method);
      if (narrowed) args = narrowed.args;
      break;
    }
    case "package": {
      const pkg = p.packageName?.trim();
      if (pkg) args.push(...select(maven ? `${pkg}.**.*` : `${pkg}.*`));
      break;
    }
    case "pattern": {
      const patterns = (p.pattern ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (patterns.length) args.push(...(maven ? select(patterns.join(",")) : patterns.flatMap(select)));
      break;
    }
    case "all":
      break;
  }
  const vm = splitJvmArgs(p.vmOptions);
  if (maven && vm.length) args.push(`-DargLine=${joinPropertyArgs(vm)}`);
  return { command: base.command, args, cwd: base.cwd ?? null };
}

const visibleFor =
  (...kinds: TestKind[]) =>
  (p: Readonly<Record<string, string>>) =>
    kinds.includes(kindOf(p));

export const junitType: RunConfigTypeContribution = {
  id: "junit",
  label: "JUnit",
  icon: "jvm-test",
  description: "Run JUnit tests through the module's Maven or Gradle build",
  defaults: { module: ROOT_MODULE, testKind: "class" },
  debugAdapter: "java-debug",
  ownsWorkingDirectory: true,
  fields: [
    {
      key: "module",
      label: "Module",
      control: "select",
      options: [],
      loadOptions: async () => buildModuleOptions(),
    },
    {
      key: "testKind",
      label: "Test kind",
      control: "select",
      options: [
        { value: "all", label: "All in module" },
        { value: "package", label: "All in package" },
        { value: "class", label: "Class" },
        { value: "method", label: "Method" },
        { value: "pattern", label: "Pattern" },
      ],
    },
    {
      key: "packageName",
      label: "Package",
      mono: true,
      required: true,
      placeholder: "e.g. com.example.service",
      visible: visibleFor("package"),
    },
    {
      key: "className",
      label: "Class",
      mono: true,
      required: true,
      placeholder: "e.g. com.example.service.UserServiceTest",
      visible: visibleFor("class", "method"),
    },
    {
      key: "methodName",
      label: "Method",
      mono: true,
      required: true,
      placeholder: "e.g. createsUser",
      visible: visibleFor("method"),
    },
    {
      key: "pattern",
      label: "Pattern",
      mono: true,
      required: true,
      placeholder: "e.g. *IT, com.example.**.*Test",
      hint: "Test class names or patterns, comma separated",
      visible: visibleFor("pattern"),
    },
    vmOptionsField("Passed to the JVM that runs the tests, not to Maven or Gradle"),
  ],
  commandLine: (p) => junitCommandLine(p, useRun.getState().configs),
  async prepareLaunch(config) {
    if (!config.command) throw new Error("JUnit configurations run through the module's Maven or Gradle build");
    const base = baseFor(config.params ?? {}, useRun.getState().configs);
    // The build's environment (its JDK), under the configuration's own variables.
    let launch: RunConfig = { ...config, env: { ...base?.env, ...config.env } };
    if (base?.kind === "gradle" && gradleForkedJvm.prepareLaunch) {
      const prepared = await gradleForkedJvm.prepareLaunch({
        ...launch,
        params: { ...launch.params, tasks: "test" },
      });
      launch = { ...prepared, params: config.params };
    }
    return launch;
  },
};
