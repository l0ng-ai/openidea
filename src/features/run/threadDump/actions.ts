/** Dump Threads of a Run session, and the tab a debug session's dump opens in (`run.openThreadDump`). */
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands, type JvmThreadDump, type JvmThreadsResult, type RunConfig } from "@/platform/ipc";
import { isJvmApplication } from "@/platform/javaLaunch";
import { useProject } from "@/platform/project";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { runJvmToken } from "../gradleRun";
import { addThreadDump, normalizeTrace, updateThreadDump } from "../stackTrace";
import { useRun, type RunSession } from "../store";
import { withDumpText, type ThreadDumpSource } from "./store";
import { threadsUnavailableText } from "./unavailableText";

/** `run.openThreadDump`'s argument: the debugger takes its dumps through its own command. */
interface ThreadDumpRequest {
  title: string;
  source: ThreadDumpSource;
  take: () => Promise<JvmThreadsResult>;
}

const KEYWORDS = ["thread dump", "jstack", "deadlock", "threads"];

const GRADLE_BOOT_RUN = /(^|:)bootRun$/;
/** Forked under Maven's JVM (`spring-boot:run`) or run inside it (`exec:java`, `jetty:run`). */
const MAVEN_RUN_GOAL = /^[\w.-]+(:[\w.-]+)*:(run|run-war|run-exploded|java)$/;

/**
 * Gradle's `run` task is left out: its JVM forks under the daemon without the run token, so the
 * dump could not find it.
 */
export function isJvmRun(config: RunConfig): boolean {
  if (config.isTest) return false;
  if (isJvmApplication(config) || config.kind === "jar-application") return true;
  if (config.kind === "gradle") return config.args.some((a) => GRADLE_BOOT_RUN.test(a));
  if (config.kind === "maven") return config.args.some((a) => MAVEN_RUN_GOAL.test(a));
  return false;
}

/** The running JVM session `id` names, else the active tab's. */
function jvmRunSession(id?: string): RunSession | undefined {
  const { sessions, activeSession } = useRun.getState();
  const s = sessions.find((x) => x.id === (id ?? activeSession));
  return s && s.status === "running" && s.runId !== null && isJvmRun(s.config) ? s : undefined;
}

/** A dump that was not taken throws why. */
async function takeDump(take: () => Promise<JvmThreadsResult>): Promise<JvmThreadDump> {
  const result = await take().catch((e: unknown): JvmThreadsResult => ({
    status: "unavailable",
    reason: { kind: "failed", message: e instanceof Error ? e.message : String(e) },
  }));
  if (result.status === "ready") return result.dump;
  throw new Error(threadsUnavailableText(result.reason));
}

async function openThreadDump({ title, source, take }: ThreadDumpRequest) {
  let dump: JvmThreadDump;
  try {
    dump = await takeDump(take);
  } catch (e) {
    notifications().notify({ group: "run", level: "warning", title: "Dump Threads", body: (e as Error).message });
    return;
  }
  const id = addThreadDump(dump.text, { title, source, virtual: dump });
  // A debug session's dump opens here too, so the Run tool window may be hidden.
  toolWindowService().show("run", true);
  // The tab reports a failed refresh itself, so this one only throws.
  const refresh = async () => {
    const next = await takeDump(take);
    const text = normalizeTrace(next.text);
    updateThreadDump(id, (t) => withDumpText(t, text, next));
  };
  updateThreadDump(id, (t) => ({ ...t, refresh }));
}

function isDumpRequest(arg: unknown): arg is ThreadDumpRequest {
  return (
    typeof arg === "object" &&
    arg !== null &&
    "title" in arg &&
    typeof arg.title === "string" &&
    "source" in arg &&
    "take" in arg &&
    typeof arg.take === "function"
  );
}

function dumpRunThreads(sessionId?: string): Promise<void> | undefined {
  const s = jvmRunSession(sessionId);
  if (!s || s.runId === null) return;
  const run = s.runId;
  const config = s.config;
  // Every run passes its token: only Gradle runs carry it, the others are found in the run's process tree.
  const token = runJvmToken(config, useProject.getState().project?.root ?? "");
  const name = config.name;
  return openThreadDump({
    title: tx`Threads: ${name}`,
    source: { run, token },
    take: () => call(commands.runJvmThreadDump(run, token)),
  });
}

export function activateThreadDumps(): () => void {
  const sync = () => setContext("run.jvmRunning", !!jvmRunSession());
  sync();
  const disposers = [
    useRun.subscribe(sync),
    registerActions([
      {
        id: "run.dumpThreads",
        title: "Dump Threads",
        category: "Run",
        icon: "thread-dump",
        keywords: KEYWORDS,
        when: "run.jvmRunning",
        indicatesRunning: true,
        // `arg`: a Run tab's session id; the active tab's otherwise.
        run: ({ arg }) => dumpRunThreads(typeof arg === "string" ? arg : undefined),
      },
      {
        id: "run.openThreadDump",
        title: "Open Thread Dump",
        category: "Run",
        hidden: true,
        run: ({ arg }) => (isDumpRequest(arg) ? openThreadDump(arg) : undefined),
      },
    ]),
  ];
  return () => disposers.forEach((d) => d());
}
