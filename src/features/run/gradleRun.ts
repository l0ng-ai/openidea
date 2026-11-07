/**
 * IDEA's "Build and run using: Gradle": an Application / Spring Boot configuration of a
 * Gradle module keeps its settings, only its launch becomes a Gradle run of a `JavaExec`
 * task (`gradleRun.gradle`) on the source set's runtime classpath. Gradle compiles the
 * module and its dependencies and processes resources first; the debugger attaches to
 * the forked JVM (`-Dopenidea.run.debug`), not to the Gradle daemon.
 */
import RUN_SCRIPT from "./gradleRun.gradle?raw";
import TESTS_SCRIPT from "./gradleTests.gradle?raw";
import { useBuildModel } from "@/platform/buildModel";
import { call, commands, isTauri, type GradleModel, type RunConfig } from "@/platform/ipc";
import { findJavaModule, isJvmApplication, parseJavaArgs } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";

/** System property that marks a delegated run (read by `jdwpLaunch` to add the debug flag). */
export const DELEGATED_MAIN = "-Dopenidea.run.main=";
export const DELEGATED_DEBUG = "-Dopenidea.run.debug=true";
/** Lets the init script start the debugged JVM's attach listener (the memory view needs it; not on Windows). */
export const DELEGATED_ATTACH_LISTENER = "-Dopenidea.run.attachListener=true";
const TASK = "openideaRun";

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
const absolute = (root: string, p: string) => (isAbsolute(p) ? p : p ? `${root}/${p}` : root);

export interface DelegationContext {
  /** Project root. */
  root: string;
  gradle: GradleModel;
  /** Absolute path of the written `gradleRun.gradle`. */
  script: string;
  offline: boolean;
  /**
   * Gradle's configuration cache: a repeated launch skips configuring the build (about half of
   * Gradle's share of a warm start). Only for Gradle 8.1+, where it is stable.
   */
  configurationCache: boolean;
}

/** Major / minor of the wrapper's `distributionUrl` (`gradle-8.10.2-bin.zip`), null when unknown. */
export function wrapperGradleVersion(properties: string): [number, number] | null {
  const m = /^\s*distributionUrl\s*=.*gradle-(\d+)\.(\d+)/m.exec(properties);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const atLeast = (v: [number, number] | null, major: number, minor: number) =>
  !!v && (v[0] > major || (v[0] === major && v[1] >= minor));

/**
 * The Gradle run of `config`, or null when it is not an Application of a module of this
 * Gradle build (`module`: its folder, project-relative or absolute).
 */
export function delegatedGradleConfig(config: RunConfig, module: string, ctx: DelegationContext): RunConfig | null {
  const parsed = parseJavaArgs(config.args);
  if (!parsed.mainClass) return null;
  const dir = absolute(ctx.root, module);
  const project = ctx.gradle.projects.find((p) => absolute(ctx.root, p.dir) === dir);
  // buildSrc tasks are not addressable from the root build; included builds' are (`:lib:core:…`).
  if (!project || project.build?.endsWith(":buildSrc")) return null;
  const task = project.path === ":" ? `:${TASK}` : `${project.path}:${TASK}`;
  const args = [
    "--console=plain",
    "--init-script",
    ctx.script,
    `-Dopenidea.run.project=${project.path}`,
    `${DELEGATED_MAIN}${parsed.mainClass}`,
    `-Dopenidea.run.sourceSet=${parsed.classpath === "test" ? "test" : "main"}`,
    `-Dopenidea.run.args=${JSON.stringify(parsed.programArgs)}`,
    `-Dopenidea.run.jvmArgs=${JSON.stringify(parsed.vmArgs)}`,
    `-Dopenidea.run.workingDir=${config.cwd ? absolute(ctx.root, config.cwd) : dir}`,
    ...(ctx.offline ? ["--offline"] : []),
    // Problems only warn: a build with incompatible plugins still runs, uncached.
    ...(ctx.configurationCache ? ["--configuration-cache", "--configuration-cache-problems=warn"] : []),
    task,
  ];
  // A Gradle run from here on: not an Application again (it would be delegated twice), and
  // without the Application's params (Gradle's own VM-options init script would repeat them).
  const { params: _params, ...rest } = config;
  return {
    ...rest,
    kind: "gradle",
    command: ctx.gradle.command,
    args,
    cwd: ctx.gradle.dir || null,
    // The Gradle JVM's JAVA_HOME first; the configuration's own environment wins.
    env: { ...ctx.gradle.env, ...config.env },
    module: module,
  };
}

/**
 * Writes an init script where Gradle reads it: on the machine that runs the build (the
 * remote host in remote development). It never changes, so once per session.
 */
const scriptPaths = new Map<string, Promise<string>>();
function writeScript(name: string, text: string): Promise<string> {
  let written = scriptPaths.get(name);
  if (!written) {
    written = call(commands.runGradleInitScript(name, text)).catch((e) => {
      scriptPaths.delete(name);
      throw e;
    });
    scriptPaths.set(name, written);
  }
  return written;
}

const isGradleCommand = (config: Pick<RunConfig, "kind" | "command">) =>
  config.kind === "gradle" || /(^|[/\\])gradlew?(\.bat)?$/.test(config.command);

/** `config` with the init script (`script`) that reports each test as it runs, for a Gradle test run. */
export function withTestEvents<T extends Pick<RunConfig, "kind" | "command" | "args">>(config: T, script: string): T {
  if (!isGradleCommand(config) || config.args.includes(script)) return config;
  return { ...config, args: ["--init-script", script, ...config.args] };
}

/**
 * A Gradle test run reporting each test as it runs (`gradleTests.gradle`): Gradle prints only
 * failures, and its XML reports are complete only once a test task ends.
 */
export async function gradleTestLaunch<T extends RunConfig>(config: T): Promise<T> {
  if (!isTauri() || !config.isTest || !isGradleCommand(config)) return config;
  try {
    return withTestEvents(config, await writeScript("openidea-gradle-tests", TESTS_SCRIPT));
  } catch (e) {
    console.warn("Gradle test init script not written", e);
    return config;
  }
}

/**
 * The launch of an Application / Spring Boot `config` through Gradle, when the project
 * runs with Gradle (Settings › Build Tools › Gradle) and the main class is in one of its
 * modules; null to launch it on the language server's classpath.
 */
export async function gradleDelegation(config: RunConfig): Promise<RunConfig | null> {
  if (!isTauri() || !isJvmApplication(config)) return null;
  const { project, settings } = useProject.getState();
  if (!project?.root || settings?.languages?.java?.gradle?.runUsing === "ide") return null;
  const { model, gradleOffline } = useBuildModel.getState();
  if (!model?.gradle?.length) return null;
  const module = config.module ?? (await findJavaModule(config));
  if (module === null) return null;
  const dir = absolute(project.root, module);
  // A composite can report a sibling's module; prefer a linked root that contains it.
  const ownerDepth = (g: GradleModel) => {
    const root = absolute(project.root, g.dir).replace(/\\/g, "/").replace(/\/+$/, "");
    const path = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`) ? root.split("/").length : 0;
  };
  const gradle = model.gradle
    .filter((g) => g.projects.some((p) => absolute(project.root, p.dir) === dir))
    .sort((a, b) => ownerDepth(b) - ownerDepth(a))[0];
  if (!gradle) return null;
  const ctx = {
    root: project.root,
    gradle,
    script: "",
    offline: gradleOffline,
    configurationCache: false,
  };
  if (!delegatedGradleConfig(config, module, ctx)) return null;
  const [script, configurationCache] = await Promise.all([
    writeScript("openidea-gradle-run", RUN_SCRIPT),
    supportsConfigurationCache(ctx),
  ]);
  return delegatedGradleConfig(config, module, { ...ctx, script, configurationCache });
}

/** The wrapper's Gradle is 8.1+ (a local or PATH Gradle's version is not known here). */
async function supportsConfigurationCache(ctx: Pick<DelegationContext, "root" | "gradle">): Promise<boolean> {
  if (!/(^|[/\\])gradlew(\.bat)?$/.test(ctx.gradle.command)) return false;
  const props = `${absolute(ctx.root, ctx.gradle.dir)}/gradle/wrapper/gradle-wrapper.properties`;
  const text = await call(commands.fsReadText(props)).catch(() => "");
  return atLeast(wrapperGradleVersion(text), 8, 1);
}
