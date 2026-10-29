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
import type { RunConfig } from "@/platform/ipc";
import { isJvmApplication, JDWP_AGENT, jdwpListeningPort } from "@/platform/javaLaunch";
import { startRun, useRun } from "./store";

const isMavenTestGoal = (a: string) =>
  /^(test|verify|integration-test|surefire:test|failsafe:integration-test)$/.test(a);
const isGradleJvmTask = (a: string) => /(^|:)(test|bootRun|run|integrationTest|check)$/.test(a);
/** A plugin goal that runs the application in Maven's own JVM (`tomcat7:run`, `jetty:run-war`, `exec:java`). */
const isMavenInProcessGoal = (a: string) => /^[\w.-]+(:[\w.-]+)*:(run|run-war|run-exploded|java)$/.test(a);
const JAVA_ADAPTER = "java-debug";

function withOption(env: Record<string, string>, key: string, value: string): Record<string, string> {
  const current = env[key]?.trim();
  return { ...env, [key]: current ? `${current} ${value}` : value };
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
  const args = config.args;
  // A single source file (`java Hi.java`): the agent goes before the file.
  if (config.kind === "java-file") return { ...config, args: [JDWP_AGENT, ...args] };
  if (config.kind === "maven" || /(^|\/)mvnw?(\.cmd)?$/.test(config.command)) {
    if (args.some((a) => a === "spring-boot:run" || /:spring-boot-maven-plugin:[^:]*:run$/.test(a)))
      return { ...config, args: withProperty(args, "spring-boot.run.jvmArguments", JDWP_AGENT) };
    if (config.isTest || args.some(isMavenTestGoal)) {
      const failsafe = args.some((a) => /integration-test|verify|failsafe/.test(a));
      let out = withProperty(args, "maven.surefire.debug", JDWP_AGENT);
      if (failsafe) out = withProperty(out, "maven.failsafe.debug", JDWP_AGENT);
      return { ...config, args: out };
    }
    if (config.debugAdapter === JAVA_ADAPTER || args.some(isMavenInProcessGoal))
      return { ...config, env: withOption(config.env, "MAVEN_OPTS", JDWP_AGENT) };
    return null;
  }
  if (config.kind === "gradle" || /(^|\/)gradlew?(\.bat)?$/.test(config.command)) {
    if (!args.some(isGradleJvmTask)) return null;
    return args.includes("--debug-jvm") ? config : { ...config, args: [...args, "--debug-jvm"] };
  }
  // Application / Spring Boot configurations are launched by java-debug itself.
  if (config.debugAdapter === JAVA_ADAPTER && !isJvmApplication(config))
    return { ...config, env: withOption(config.env, "JAVA_TOOL_OPTIONS", JDWP_AGENT) };
  return null;
}

/** Runs `config` with a JDWP agent and attaches the Java debugger to every JVM it starts. */
export async function debugWithAgent(config: RunConfig): Promise<boolean> {
  const launch = jdwpLaunch(config);
  if (!launch) return false;
  let sessionId: string | null = null;
  const waiting: number[] = [];
  const attach = (port: number) => {
    const runId = useRun.getState().sessions.find((s) => s.id === sessionId)?.runId ?? null;
    void executeAction("debug.attach", {
      name: config.name,
      module: config.cwd ?? "",
      hostName: "127.0.0.1",
      port,
      process: runId,
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
