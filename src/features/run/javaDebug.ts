/**
 * Debugging Maven / Gradle run configurations (IDEA debugs those too): the
 * build tool starts the JVM with a JDWP agent that waits for a debugger
 * (`spring-boot:run` → `-Dspring-boot.run.jvmArguments`, Surefire →
 * `-Dmaven.surefire.debug`, Gradle → `--debug-jvm`); when the agent reports
 * its port, the Java debugger attaches. The test tree stays in the Run tab; the
 * Debug console shows the output as well.
 * Maven goals that run the application inside Maven's JVM (`tomcat7:run`, `jetty:run`,
 * `exec:java`) get the agent through `MAVEN_OPTS`; any other configuration set to the Java
 * debugger (a script such as `catalina.sh run`) through `JAVA_TOOL_OPTIONS`, which every JVM reads.
 */
import { executeAction } from "@/platform/actions";
import { call, commands, type RunConfig } from "@/platform/ipc";
import {
  ATTACH_LISTENER,
  isJvmApplication,
  JDWP_AGENT,
  jdwpListeningPort,
  optsOutOfAttach,
} from "@/platform/javaLaunch";
import { applyBuildPolicyToCommand } from "./buildCommand";
import { startRun, useRun } from "./store";
import { DELEGATED_ATTACH_LISTENER, DELEGATED_DEBUG, DELEGATED_MAIN } from "./gradleRun";
import { isWindows } from "./jvmTypes";

const isMavenTestGoal = (a: string) =>
  /^(test|verify|integration-test|surefire:test|failsafe:integration-test)$/.test(a);
const isGradleJvmTask = (a: string) => /(^|:)(test|bootRun|run|integrationTest|check)$/.test(a);
/** A plugin goal that runs the application in Maven's own JVM (`tomcat7:run`, `jetty:run-war`, `exec:java`). */
const isMavenInProcessGoal = (a: string) => /^[\w.-]+(:[\w.-]+)*:(run|run-war|run-exploded|java)$/.test(a);
const JVM_ADAPTERS = ["java-debug", "kotlin-debug-adapter"];

function withOption(env: Record<string, string>, key: string, value: string): Record<string, string> {
  const current = env[key]?.trim();
  return { ...env, [key]: current ? `${current} ${value}` : value };
}

/**
 * The agent, preceded by the attach listener unless a VM option of the configuration or the
 * channel's current value (`existing`) already decides about the attach mechanism. Not on
 * Windows, where the memory view that needs the listener is not available.
 */
function agentOptions(config: RunConfig, ...existing: (string | undefined)[]): string[] {
  const options = [config.params?.vmOptions, ...existing].filter(Boolean).join(" ");
  return isWindows() || optsOutOfAttach(options) ? [JDWP_AGENT] : [ATTACH_LISTENER, JDWP_AGENT];
}

const agentText = (config: RunConfig, ...existing: (string | undefined)[]) =>
  agentOptions(config, ...existing).join(" ");

function propertyValue(args: readonly string[], key: string): string | undefined {
  const prefix = `-D${key}=`;
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function withProperty(args: readonly string[], key: string, value: string): string[] {
  const prefix = `-D${key}=`;
  const i = args.findIndex((a) => a.startsWith(prefix));
  if (i < 0) return [...args, prefix + value];
  const current = args[i]!.slice(prefix.length).trim();
  const out = [...args];
  out[i] = prefix + (current ? `${current} ${value}` : value);
  return out;
}

/** The configuration with a waiting JDWP agent, or null when it starts no debuggable JVM.
 *  `jdwpPort`: pin a Surefire / Failsafe fork to this port — its "Listening for transport"
 *  line stays buffered until the tests run, which `suspend=y` prevents, so the port must be
 *  known without it. */
export function jdwpLaunch(config: RunConfig, jdwpPort?: number): RunConfig | null {
  config = applyBuildPolicyToCommand(config);
  if (config.kind === "tomcat") return { ...config, params: { ...config.params, tomcatDebug: "true" } };
  const args = config.args;
  if (config.kind === "jar-application") return { ...config, args: [JDWP_AGENT, ...args] };
  // A single source file (`java Hi.java`): the agent goes before the file. Compiled first
  // (`javac … && java -cp …`): through `JDK_JAVA_OPTIONS`, which only the `java` launcher reads.
  if (config.kind === "java-file")
    return args.length
      ? { ...config, args: [...agentOptions(config, args.join(" ")), ...args] }
      : { ...config, env: withOption(config.env, "JDK_JAVA_OPTIONS", agentText(config, config.env.JDK_JAVA_OPTIONS)) };
  if (config.kind === "maven" || /(^|\/)mvnw?(\.cmd)?$/.test(config.command)) {
    if (args.some((a) => a === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(a))) {
      const options = agentText(config, propertyValue(args, "spring-boot.run.jvmArguments"));
      return { ...config, args: withProperty(args, "spring-boot.run.jvmArguments", options) };
    }
    if (config.isTest || args.some(isMavenTestGoal)) {
      const failsafe = args.some((a) => /integration-test|verify|failsafe/.test(a));
      // Forked-JVM options of the test goals come as `-DargLine=…` among the arguments.
      const options = agentText(config, args.join(" "));
      const agent = jdwpPort ? options.replace("address=127.0.0.1:0", `address=127.0.0.1:${jdwpPort}`) : options;
      let out = withProperty(args, "maven.surefire.debug", agent);
      if (failsafe) out = withProperty(out, "maven.failsafe.debug", agent);
      return { ...config, args: out };
    }
    if (JVM_ADAPTERS.includes(config.debugAdapter ?? "") || args.some(isMavenInProcessGoal))
      return { ...config, env: withOption(config.env, "MAVEN_OPTS", agentText(config, config.env.MAVEN_OPTS)) };
    return null;
  }
  if (config.kind === "gradle" || /(^|\/)gradlew?(\.bat)?$/.test(config.command)) {
    // A delegated Application: its init script adds the agent (port 0) to the JavaExec JVM.
    if (args.some((a) => a.startsWith(DELEGATED_MAIN))) {
      const flags = isWindows() ? [DELEGATED_DEBUG] : [DELEGATED_ATTACH_LISTENER, DELEGATED_DEBUG];
      const missing = flags.filter((f) => !args.includes(f));
      return missing.length ? { ...config, args: [...args, ...missing] } : config;
    }
    // Gradle Test forks test workers: the init script gives them a dynamic JDWP port.
    if (config.isTest || args.some((a) => /(^|:)(test|integrationTest)$/.test(a)))
      return args.includes(DELEGATED_DEBUG) ? config : { ...config, args: [...args, DELEGATED_DEBUG] };
    // BootRun's init script gives the forked application JVM a dynamic port.
    if (args.some((a) => /(^|:)bootRun$/.test(a)))
      return args.includes(DELEGATED_DEBUG) ? config : { ...config, args: [...args, DELEGATED_DEBUG] };
    if (!args.some(isGradleJvmTask)) return null;
    return args.includes("--debug-jvm") ? config : { ...config, args: [...args, "--debug-jvm"] };
  }
  // Application / Spring Boot configurations are launched by java-debug itself.
  if (JVM_ADAPTERS.includes(config.debugAdapter ?? "") && !isJvmApplication(config))
    return {
      ...config,
      env: withOption(config.env, "JAVA_TOOL_OPTIONS", agentText(config, config.env.JAVA_TOOL_OPTIONS)),
    };
  return null;
}

/**
 * `--debug-jvm` makes Gradle add the agent itself, so the attach listener reaches the forked
 * JVMs through an init script (the one VM options use). A failure only costs the memory view.
 */
async function withGradleAttachListener(launch: RunConfig): Promise<RunConfig> {
  if (isWindows() || !launch.args.includes("--debug-jvm") || launch.target) return launch;
  if (optsOutOfAttach([launch.params?.vmOptions, ...launch.args].join(" "))) return launch;
  try {
    const script = await call(commands.runGradleJvmArgsScript([ATTACH_LISTENER]));
    return { ...launch, args: ["--init-script", script, ...launch.args] };
  } catch (e) {
    console.warn("Could not add the attach listener to the Gradle debug run", e);
    return launch;
  }
}

/**
 * Surefire / Failsafe print this banner just before they start the forked test JVM. It comes from
 * Maven itself, so unlike the fork's "Listening" line it is not held back until the tests run.
 */
const SGR = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
export const isTestForkBanner = (line: string) => /^(?:\[INFO\])?\s*T E S T S$/.test(line.replace(SGR, "").trim());

/** A Maven test launch: its Surefire / Failsafe fork holds the "Listening" line, so pin its JDWP port. */
function needsPinnedPort(config: RunConfig): boolean {
  if (config.kind !== "maven" && !/(^|\/)mvnw?(\.cmd)?$/.test(config.command)) return false;
  return config.isTest || config.args.some(isMavenTestGoal);
}

/** Runs `config` with a JDWP agent and attaches the Java debugger to every JVM it starts. */
export async function debugWithAgent(config: RunConfig, show?: boolean): Promise<boolean> {
  const pinned = needsPinnedPort(config) ? await call(commands.debugFreePort()).catch(() => null) : null;
  const agent = jdwpLaunch(config, pinned ?? undefined);
  if (!agent) return false;
  const launch = await withGradleAttachListener(agent);
  let sessionId: string | null = null;
  const waiting: number[] = [];
  const attached = new Set<number>();
  const attach = (port: number) => {
    if (attached.has(port)) return;
    attached.add(port);
    const runId = useRun.getState().sessions.find((s) => s.id === sessionId)?.runId ?? null;
    void executeAction("debug.attach", {
      name: config.name,
      // The application's module (a delegated run's working directory is the Gradle build).
      module: config.module ?? config.cwd ?? "",
      hostName: "127.0.0.1",
      port,
      process: runId,
      runConfig: config,
      show,
    });
  };
  const session = await startRun(config, undefined, undefined, {
    launch,
    show,
    onLine: (line) => {
      // The pinned port is attached when the fork starts: java-debug retries the connect for
      // 30 s, which compiling and resolving dependencies before the tests can use up.
      const port = jdwpListeningPort(line) ?? (pinned !== null && isTestForkBanner(line) ? pinned : null);
      if (port === null) return;
      if (sessionId) attach(port);
      else waiting.push(port);
    },
  });
  if (!session) return true;
  sessionId = session.id;
  waiting.splice(0).forEach(attach);
  return true;
}
