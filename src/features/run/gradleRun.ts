/**
 * IDEA's "Build and run using: Gradle": an Application / Spring Boot configuration of a
 * Gradle module keeps its settings, only its launch becomes a Gradle run of a `JavaExec`
 * task (`gradleRun.gradle`) on the source set's runtime classpath. Gradle compiles the
 * module and its dependencies and processes resources first; the debugger attaches to
 * the forked JVM (`-Dopenidea.run.debug`), not to the Gradle daemon.
 */
import RUN_SCRIPT from "./gradleRun.gradle?raw";
import { useBuild } from "@/features/build-tools/store";
import { call, commands, isTauri, type GradleModel, type RunConfig } from "@/platform/ipc";
import { consoleVmArgs, findJavaModule, isJvmApplication, parseJavaArgs } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";

/** System property that marks a delegated run (read by `jdwpLaunch` to add the debug flag). */
export const DELEGATED_MAIN = "-Dopenidea.run.main=";
export const DELEGATED_DEBUG = "-Dopenidea.run.debug=true";
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
  if (!project) return null;
  const task = project.path === ":" ? `:${TASK}` : `${project.path}:${TASK}`;
  const args = [
    "--console=plain",
    "--init-script",
    ctx.script,
    `-Dopenidea.run.project=${project.path}`,
    `${DELEGATED_MAIN}${parsed.mainClass}`,
    `-Dopenidea.run.sourceSet=${parsed.classpath === "test" ? "test" : "main"}`,
    `-Dopenidea.run.args=${JSON.stringify(parsed.programArgs)}`,
    `-Dopenidea.run.jvmArgs=${JSON.stringify([...consoleVmArgs(config), ...parsed.vmArgs])}`,
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

/** Writes the init script where Gradle can read it; it never changes, so once per session. */
let scriptPath: Promise<string> | null = null;
function writeScript(): Promise<string> {
  scriptPath ??= (async () => {
    const { tempDir, join } = await import("@tauri-apps/api/path");
    const path = await join(await tempDir(), "openidea-gradle-run.gradle");
    await call(commands.fsDelete(path)).catch(() => {});
    await call(commands.fsCreateFileBytes(path, Array.from(new TextEncoder().encode(RUN_SCRIPT))));
    return path;
  })().catch((e) => {
    scriptPath = null;
    throw e;
  });
  return scriptPath;
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
  const { model, settings: build } = useBuild.getState();
  if (!model?.gradle) return null;
  const module = config.module ?? (await findJavaModule(config));
  if (module === null) return null;
  const ctx = {
    root: project.root,
    gradle: model.gradle,
    script: "",
    offline: build.gradle.offline,
    configurationCache: false,
  };
  if (!delegatedGradleConfig(config, module, ctx)) return null;
  const [script, configurationCache] = await Promise.all([writeScript(), supportsConfigurationCache(ctx)]);
  return delegatedGradleConfig(config, module, { ...ctx, script, configurationCache });
}

/** The wrapper's Gradle is 8.1+ (a local or PATH Gradle's version is not known here). */
async function supportsConfigurationCache(ctx: Pick<DelegationContext, "root" | "gradle">): Promise<boolean> {
  if (!/(^|[/\\])gradlew(\.bat)?$/.test(ctx.gradle.command)) return false;
  const props = `${absolute(ctx.root, ctx.gradle.dir)}/gradle/wrapper/gradle-wrapper.properties`;
  const text = await call(commands.fsReadText(props)).catch(() => "");
  return atLeast(wrapperGradleVersion(text), 8, 1);
}
