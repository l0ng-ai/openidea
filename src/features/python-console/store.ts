/** The Python Console's process: the project interpreter running console.py on the Run process host. */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { call, commands, onIdeEvent, type OutputChunk, type RunConfig, type RunId } from "@/platform/ipc";
import { windowLabel } from "@/platform/auxWindow";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { AnsiStream, appendSpans, type Span } from "@/ui/ansi";
import DRIVER from "./console.py?raw";
import { request, stdoutParser, type ConsoleMessage, type ConsoleVariable } from "./protocol";

export type ConsoleStatus = "stopped" | "starting" | "idle" | "busy";

interface ConsoleState {
  status: ConsoleStatus;
  /** "Python 3.12.1 (IPython 8.20.0)" once the driver is up. */
  header: string | null;
  output: Span[];
  variables: ConsoleVariable[];
  /** No interpreter is selected for the project. */
  noInterpreter: boolean;
  history: string[];
}

const initial = (): ConsoleState => ({
  status: "stopped",
  header: null,
  output: [],
  variables: [],
  noInterpreter: false,
  history: [],
});

export const useConsole = create<ConsoleState>(initial);

// ponytail: the oldest output goes past the cap; a virtualised list if consoles need more.
const MAX_CHARS = 1_000_000;
let runId: RunId | null = null;
let generation = 0;
const queue: string[] = [];

/** The last `max` characters of `spans`. */
export function tail(spans: Span[], max = MAX_CHARS): Span[] {
  let total = 0;
  let i = spans.length;
  while (i > 0 && total + spans[i - 1]!.text.length <= max) total += spans[--i]!.text.length;
  if (i === 0) return spans;
  const cut = spans[i - 1]!;
  return [{ ...cut, text: cut.text.slice(cut.text.length - (max - total)) }, ...spans.slice(i)];
}

function append(spans: Span[]) {
  if (spans.length) useConsole.setState({ output: tail(appendSpans(useConsole.getState().output, spans)) });
}

const note = (text: string) => append([{ text, dim: true }]);

function echo(code: string) {
  const lines = code.replace(/\n+$/, "").split("\n");
  append([{ text: lines.map((l, i) => (i ? "... " : ">>> ") + l).join("\n") + "\n", fg: "var(--accent)" }]);
}

function next() {
  const code = queue.shift();
  if (code === undefined || runId === null) return;
  useConsole.setState({ status: "busy" });
  echo(code);
  void call(commands.runStdin(runId, request(code))).catch((e) => note(`${String(e)}\n`));
}

function onMessage(message: ConsoleMessage) {
  if ("ready" in message) {
    const { version, ipython } = message.ready;
    useConsole.setState({ header: ipython ? `Python ${version} (${ipython})` : `Python ${version}`, status: "idle" });
  } else {
    useConsole.setState({ variables: message.done.variables, status: "idle" });
  }
  next();
}

/** Run ids of this window's consoles: a reloaded page finds the ones its previous load left running. */
const PREFIX = `python-console:${windowLabel()}:`;

function config(python: string, cwd: string): RunConfig {
  return {
    id: `${PREFIX}${crypto.randomUUID()}`,
    name: "Python Console",
    // "python" puts the project's source roots on PYTHONPATH and unbuffers output.
    kind: "python",
    command: python,
    args: ["-u", "-c", DRIVER],
    cwd,
    env: {},
    detected: true,
    isTest: false,
    debugAdapter: null,
    emulateTerminal: false,
  };
}

export async function startConsole() {
  if (useConsole.getState().status !== "stopped") return;
  const root = useProject.getState().project?.root;
  if (!root) return;
  const mine = ++generation;
  useConsole.setState({ status: "starting", noInterpreter: false, header: null, variables: [] });
  try {
    const python = await call(commands.sdkPythonEffective(null));
    if (mine !== generation) return;
    if (!python) {
      queue.length = 0;
      useConsole.setState({ status: "stopped", noInterpreter: true });
      return;
    }
    const out = new AnsiStream();
    const err = new AnsiStream();
    const parse = stdoutParser();
    const channel = new Channel<OutputChunk>();
    channel.onmessage = (chunk) => {
      if (mine !== generation) return;
      if (chunk.kind === "stdout") {
        const { text, messages } = parse(chunk.text);
        append(out.parse(text));
        messages.forEach(onMessage);
      } else if (chunk.kind === "stderr") {
        append(err.parse(chunk.text).map((s) => (s.fg ? s : { ...s, fg: "var(--ansi-red)" })));
      }
      // "system" chunks echo the command line, which is the driver's source here.
    };
    const info = await call(commands.runStart(config(python, root), channel, null));
    if (mine !== generation) void call(commands.runStop(info.id)).catch(() => {});
    else {
      runId = info.id;
      // The driver may be ready before the start call returns.
      if (useConsole.getState().status === "idle") next();
    }
  } catch (e) {
    if (mine !== generation) return;
    queue.length = 0;
    useConsole.setState({ status: "stopped" });
    note(`${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Runs `code` now, or after the statement in progress (starting the console first if needed). */
export function execute(code: string) {
  if (!code.trim()) return;
  const { history } = useConsole.getState();
  if (history[history.length - 1] !== code) useConsole.setState({ history: [...history, code].slice(-200) });
  queue.push(code);
  const { status } = useConsole.getState();
  if (status === "stopped") void startConsole();
  else if (status === "idle") next();
}

/** A line typed while code runs: what its `input()` reads. */
export function sendInput(line: string) {
  if (runId === null) return;
  append([{ text: `${line}\n` }]);
  void call(commands.runStdin(runId, `${line}\n`)).catch(() => {});
}

export function stopConsole() {
  generation++;
  queue.length = 0;
  const id = runId;
  runId = null;
  if (id !== null) void call(commands.runStop(id)).catch(() => {});
  useConsole.setState({ status: "stopped", variables: [] });
}

export function restartConsole() {
  stopConsole();
  useConsole.setState({ output: [] });
  void startConsole();
}

export const clearOutput = () => useConsole.setState({ output: [] });

/** Exit reporting, and a fresh console for each project. */
export function installConsole(): () => void {
  void commands
    .runList()
    .then((runs) => {
      for (const r of runs)
        if (r.running && r.id !== runId && r.configId.startsWith(PREFIX)) void commands.runStop(r.id);
    })
    .catch(() => {});
  const offExit = onIdeEvent("runExited", (e) => {
    if (e.run !== runId) return;
    runId = null;
    queue.length = 0;
    useConsole.setState({ status: "stopped" });
    note(`${tx`\n[Process finished with exit code ${String(e.code ?? "?")}]`}\n`);
  });
  const offProject = useProject.subscribe((s, prev) => {
    if (s.project?.root === prev.project?.root) return;
    stopConsole();
    useConsole.setState(initial());
  });
  return () => {
    offExit();
    offProject();
    stopConsole();
  };
}
