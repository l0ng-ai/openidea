/**
 * Debugging Maven / Gradle run configurations (IDEA debugs those too): the
 * build tool starts the JVM with a JDWP agent that waits for a debugger
 * (`spring-boot:run` → `-Dspring-boot.run.jvmArguments`, Surefire →
 * `-Dmaven.surefire.debug`, Gradle → `--debug-jvm`); when the agent reports
 * its port, the Java debugger attaches. Output and the test tree stay in the Run tab.
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
import { startRun, useRun } from "./store";
import { DELEGATED_DEBUG, DELEGATED_MAIN } from "./gradleRun";

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
 * channel's current value (`existing`) already decides about the attach mechanism.
 */
function agentOptions(config: RunConfig, ...existing: (string | undefined)[]): string[] {
  const options = [config.params?.vmOptions, ...existing].filter(Boolean).join(" ");
  return optsOutOfAttach(options) ? [JDWP_AGENT] : [ATTACH_LISTENER, JDWP_AGENT];
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

/** The configuration with a waiting JDWP agent, or null when it starts no debuggable JVM. */
export function jdwpLaunch(config: RunConfig): RunConfig | null {
  if (config.kind === "tomcat") return { ...config, params: { ...config.params, tomcatDebug: "true" } };
  const args = config.args;
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
      let out = withProperty(args, "maven.surefire.debug", options);
      if (failsafe) out = withProperty(out, "maven.failsafe.debug", options);
      return { ...config, args: out };
    }
    if (JVM_ADAPTERS.includes(config.debugAdapter ?? "") || args.some(isMavenInProcessGoal))
      return { ...config, env: withOption(config.env, "MAVEN_OPTS", agentText(config, config.env.MAVEN_OPTS)) };
    return null;
  }
  if (config.kind === "gradle" || /(^|\/)gradlew?(\.bat)?$/.test(config.command)) {
    // A delegated Application: its init script adds the agent (port 0) to the JavaExec JVM.
    if (args.some((a) => a.startsWith(DELEGATED_MAIN)))
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
  if (!launch.args.includes("--debug-jvm") || launch.target) return launch;
  if (optsOutOfAttach([launch.params?.vmOptions, ...launch.args].join(" "))) return launch;
  try {
    const script = await call(commands.runGradleJvmArgsScript([ATTACH_LISTENER]));
    return { ...launch, args: ["--init-script", script, ...launch.args] };
  } catch (e) {
    console.warn("Could not add the attach listener to the Gradle debug run", e);
    return launch;
  }
}

/** Runs `config` with a JDWP agent and attaches the Java debugger to every JVM it starts. */
export async function debugWithAgent(config: RunConfig): Promise<boolean> {
  const agent = jdwpLaunch(config);
  if (!agent) return false;
  const launch = await withGradleAttachListener(agent);
  let sessionId: string | null = null;
  const waiting: number[] = [];
  const attach = (port: number) => {
    const runId = useRun.getState().sessions.find((s) => s.id === sessionId)?.runId ?? null;
    void executeAction("debug.attach", {
      name: config.name,
      // The application's module (a delegated run's working directory is the Gradle build).
      module: config.module ?? config.cwd ?? "",
      hostName: "127.0.0.1",
      port,
      process: runId,
      runConfig: config,
    });
  };
  const session = await startRun(config, undefined, undefined, {
    launch,
    onLine: (line) => {
      const port = jdwpListeningPort(line);
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
