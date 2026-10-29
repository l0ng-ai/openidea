/**
 * JVM run configuration types: Application and Spring Boot
 * (`java [VM options] -cp ${classpath} <main class> [program arguments]`), and the
 * VM options Maven / Gradle configurations hand to the JVM the build forks
 * (`spring-boot:run`, tests, `bootRun`) rather than to the build tool's own JVM.
 */
import { call, commands, type RunConfig } from "@/platform/ipc";
import { CLASSPATH, parseJavaArgs, TEST_CLASSPATH } from "@/platform/javaLaunch";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";

export const isWindows = () => typeof navigator !== "undefined" && /win/i.test(navigator.platform);

/** VM options / program arguments as typed; on Windows a backslash is a path separator. */
export const splitJvmArgs = (text: string | undefined, windows = isWindows()) => parseArgs(text ?? "", windows);

export const PROFILES_ARG = "--spring.profiles.active=";

const VM_OPTIONS_PLACEHOLDER = "e.g. -Xmx1g -Dkey=value --add-opens java.base/java.lang=ALL-UNNAMED";

const vmOptionsField = (hint?: string, visible?: RunConfigTypeField["visible"]): RunConfigTypeField => ({
  key: "vmOptions",
  label: "VM options",
  control: "textarea",
  rows: 2,
  mono: true,
  placeholder: VM_OPTIONS_PLACEHOLDER,
  ...(hint ? { hint } : {}),
  ...(visible ? { visible } : {}),
});

const profilesField = (hint: string, visible?: RunConfigTypeField["visible"]): RunConfigTypeField => ({
  key: "activeProfiles",
  label: "Active profiles",
  mono: true,
  placeholder: "e.g. dev,local",
  hint,
  ...(visible ? { visible } : {}),
});

const isJava = (command: string) => /^java(\.exe)?$/i.test(command.replace(/\\/g, "/").split("/").pop() ?? "");

/** Main classes of the JVM configurations, offered while typing. */
function mainClasses(configs: readonly RunConfig[]): string[] {
  const out = new Set<string>();
  for (const c of configs) {
    if (c.kind !== "application" && c.kind !== "spring-boot") continue;
    const main = c.params?.mainClass || parseJavaArgs(c.args).mainClass;
    if (main) out.add(main);
  }
  return [...out];
}

function jvmApplicationType(spring: boolean): RunConfigTypeContribution {
  return {
    id: spring ? "spring-boot" : "application",
    label: spring ? "Spring Boot" : "Application",
    icon: spring ? "spring-boot" : "class",
    description: spring ? "Run a Spring Boot application" : "Run a Java main class",
    defaults: { classpath: CLASSPATH },
    debugAdapter: "java-debug",
    fields: [
      {
        key: "mainClass",
        label: "Main class",
        mono: true,
        required: true,
        placeholder: "e.g. com.example.Application",
        suggestions: mainClasses,
      },
      vmOptionsField(),
      { key: "programArgs", label: "Program arguments", mono: true },
      ...(spring ? [profilesField("Comma separated; passed as --spring.profiles.active")] : []),
      {
        key: "classpath",
        label: "Classpath",
        control: "select",
        options: [
          { value: CLASSPATH, label: "Runtime classpath of the module" },
          { value: TEST_CLASSPATH, label: "Test classpath of the module" },
        ],
      },
    ],
    commandLine(p) {
      const main = p.mainClass?.trim() ?? "";
      const profiles = spring ? (p.activeProfiles?.trim() ?? "") : "";
      return {
        command: "java",
        args: [
          ...splitJvmArgs(p.vmOptions),
          "-cp",
          p.classpath || CLASSPATH,
          ...(main ? [main] : []),
          ...(profiles ? [PROFILES_ARG + profiles] : []),
          ...splitJvmArgs(p.programArgs),
        ],
      };
    },
    // Configurations detected or saved before these fields existed: `java [vm] -cp <cp> Main [args]`.
    paramsFrom(c) {
      if (!isJava(c.command)) return null;
      const parsed = parseJavaArgs(c.args);
      const classpath =
        parsed.classpath === "runtime"
          ? CLASSPATH
          : parsed.classpath === "test"
            ? TEST_CLASSPATH
            : parsed.explicitClasspath;
      if (!parsed.mainClass || classpath === null) return null;
      let rest = parsed.programArgs;
      let activeProfiles = "";
      if (spring && rest[0]?.startsWith(PROFILES_ARG)) {
        activeProfiles = rest[0].slice(PROFILES_ARG.length);
        rest = rest.slice(1);
      }
      return {
        mainClass: parsed.mainClass,
        vmOptions: formatArgs(parsed.vmArgs),
        programArgs: formatArgs(rest),
        classpath,
        ...(activeProfiles ? { activeProfiles } : {}),
      };
    },
  };
}

export const applicationType = jvmApplicationType(false);
export const springBootType = jvmApplicationType(true);

/**
 * One value for a Maven property holding JVM arguments (`spring-boot.run.jvmArguments`,
 * `argLine`): the plugins split it on whitespace, honouring "…" and '…'.
 */
export function joinPropertyArgs(args: readonly string[]): string {
  return args
    .map((a) => {
      if (a && !/[\s"']/.test(a)) return a;
      return a.includes('"') ? `'${a}'` : `"${a}"`;
    })
    .join(" ");
}

const words = (tasks: string | undefined) => (tasks ?? "").split(/\s+/).filter(Boolean);

const isSpringBootRun = (goal: string) =>
  goal === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(goal);
const isMavenTestGoal = (goal: string) =>
  /^(test|verify|integration-test|surefire:test|failsafe:integration-test)$/.test(goal);
const isBootRun = (task: string) => /(^|:)bootRun$/.test(task);
const isGradleJvmTask = (task: string) => /(^|:)(test|bootRun|run|integrationTest|check)$/.test(task);

/** What a build tool configuration does with VM options and Spring Boot profiles. */
export interface ForkedJvm {
  fields: readonly RunConfigTypeField[];
  /** Arguments appended to the build tool's command line. */
  args(params: Readonly<Record<string, string>>): string[];
  prepareLaunch?(config: RunConfig): Promise<RunConfig>;
}

export const mavenForkedJvm: ForkedJvm = {
  fields: [
    vmOptionsField("Passed to the JVM that spring-boot:run or the tests start, not to Maven", (p) =>
      words(p.tasks).some((g) => isSpringBootRun(g) || isMavenTestGoal(g)),
    ),
    profilesField("Comma separated; passed as -Dspring-boot.run.profiles", (p) => words(p.tasks).some(isSpringBootRun)),
  ],
  args(p) {
    const goals = words(p.tasks);
    const vm = splitJvmArgs(p.vmOptions);
    const out: string[] = [];
    if (goals.some(isSpringBootRun)) {
      if (vm.length) out.push(`-Dspring-boot.run.jvmArguments=${joinPropertyArgs(vm)}`);
      const profiles = p.activeProfiles?.trim();
      if (profiles) out.push(`-Dspring-boot.run.profiles=${profiles}`);
    } else if (vm.length && goals.some(isMavenTestGoal)) {
      out.push(`-DargLine=${joinPropertyArgs(vm)}`);
    }
    return out;
  },
};

/** VM options (and profiles, as `-Dspring.profiles.active`) of a Gradle configuration's forked JVMs. */
export function gradleJvmArgs(p: Readonly<Record<string, string>>): string[] {
  const tasks = words(p.tasks);
  if (!tasks.some(isGradleJvmTask)) return [];
  const profiles = tasks.some(isBootRun) ? p.activeProfiles?.trim() : "";
  return [...splitJvmArgs(p.vmOptions), ...(profiles ? [`-Dspring.profiles.active=${profiles}`] : [])];
}

export const gradleForkedJvm: ForkedJvm = {
  fields: [
    vmOptionsField("Passed to the JVMs the tasks start (bootRun, run, test), not to Gradle", (p) =>
      words(p.tasks).some(isGradleJvmTask),
    ),
    profilesField("Comma separated; passed as -Dspring.profiles.active", (p) => words(p.tasks).some(isBootRun)),
  ],
  // Gradle has no command-line switch for them: an init script adds them to the JavaExec / Test tasks.
  args: () => [],
  async prepareLaunch(config) {
    const jvmArgs = gradleJvmArgs(config.params ?? {});
    if (!jvmArgs.length) return config;
    if (config.target) throw new Error("VM options of Gradle configurations are not applied on run targets");
    const script = await call(commands.runGradleJvmArgsScript(jvmArgs));
    return { ...config, args: ["--init-script", script, ...config.args] };
  },
};
