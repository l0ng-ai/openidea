/**
 * Run manage.py Task (PyCharm's Tools | Run manage.py Task): `manage.py <command>` lines in
 * Run Anything, with the project's commands from `manage.py help` as completions. The line
 * runs with the project interpreter in a terminal-emulating Run tab, so prompts
 * (`createsuperuser`, `shell`) work.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { activePython, parseArgs } from "@/platform/commandLine";
import {
  call,
  commands,
  ideEventsReady,
  onIdeEvent,
  type OutputChunk,
  type RunConfig,
  type RunId,
} from "@/platform/ipc";
import { findManage } from "@/platform/django";
import { usePlatform } from "@/platform/platformInfo";
import { dirname } from "@/platform/project";
import {
  maybeEditorService,
  notifications,
  type RunAnythingItem,
  type RunAnythingProvider,
  type TerminalCommandContext,
} from "@/workbench/contributions";

export interface ManageCommand {
  name: string;
  /** The app that defines it: `django`, `auth`, `staticfiles`, a project app. */
  app: string;
}

/** The script name, as typed in command lines. */
const MANAGE = "manage.py";

/** `manage.py migrate`, `./manage.py` / `.\manage.py`, `python`, `python3.12`, `python.exe`, `py`, `py -3.12`. */
const LINE = /^(?:(?:py(?:\s+-[\d.]+)?|python[\d.]*(?:\.exe)?)\s+)?(?:\.[\\/])?manage\.py(?:\s+|$)/;

/** The arguments after `manage.py`, or null when `line` isn't a manage.py command line. */
export function manageArgs(line: string, windows = usePlatform.getState().os === "windows"): string[] | null {
  const head = LINE.exec(line.trim());
  return head ? parseArgs(line.trim().slice(head[0].length), windows) : null;
}

/** Commands listed by `manage.py help`: `[app]` headings, each followed by indented command names. */
export function parseHelp(text: string): ManageCommand[] {
  const out: ManageCommand[] = [];
  let app: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^\[(.+)\]\s*$/.exec(line);
    if (heading) app = heading[1]!;
    else if (!/^\s/.test(line)) app = null;
    else if (app && /^\s+[\w-]+\s*$/.test(line)) out.push({ name: line.trim(), app });
  }
  return out;
}

export function manageConfig(python: string, manage: string, args: readonly string[]): RunConfig {
  const line = ["manage.py", ...args].join(" ");
  return {
    id: `django.manage:${line}`,
    name: line.length > 60 ? `${line.slice(0, 57)}…` : line,
    // "python" puts the project's source roots on PYTHONPATH and unbuffers output.
    kind: "python",
    command: python,
    args: ["manage.py", ...args],
    cwd: dirname(manage),
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
    emulateTerminal: true,
  };
}

interface ManageState {
  /** The manage.py (and its interpreter) the last lookup found. */
  manage: string | null;
  python: string | null;
  /** Commands by manage.py, read once each. */
  commands: Record<string, ManageCommand[]>;
  /** manage.py files whose `help` failed: not read again until Run manage.py Task asks. */
  failed: Record<string, true>;
}

const empty = (): ManageState => ({ manage: null, python: null, commands: {}, failed: {} });
export const useManage = create<ManageState>(empty);

/** Bumped by each reset: work started for an earlier project doesn't write into the store. */
let epoch = 0;
const reading = new Map<string, Promise<void>>();

export function resetManage() {
  epoch++;
  reading.clear();
  useManage.setState(empty());
}

/** Output of a short process on the Run process host (no Run tab). */
async function capture(config: RunConfig, timeoutMs = 30_000): Promise<{ out: string; err: string }> {
  await ideEventsReady();
  let id: RunId | undefined;
  let out = "";
  let err = "";
  const exits = new Set<RunId>();
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => (finish = resolve));
  const off = onIdeEvent("runExited", (e) => {
    if (id === undefined) exits.add(e.run);
    else if (e.run === id) finish();
  });
  const channel = new Channel<OutputChunk>();
  channel.onmessage = (chunk) => {
    if (chunk.kind === "stdout" && out.length < 1_000_000) out += chunk.text;
    if (chunk.kind === "stderr" && err.length < 100_000) err += chunk.text;
  };
  const timer = setTimeout(() => id !== undefined && void call(commands.runStop(id)).catch(() => {}), timeoutMs);
  try {
    id = (await call(commands.runStart(config, channel, null))).id;
    if (exits.has(id)) finish();
    await exited;
    return { out, err };
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** The file the lookup starts from: the active editor's, so a monorepo uses that project's manage.py. */
const near = () => maybeEditorService()?.activePath() ?? null;
/** The file the last lookup started from: another active file may belong to another project. */
let lookedUpFrom: string | null = null;

/** The manage.py of the active file's project and its interpreter (looked up each time: the index may still be building). */
export async function locateManage(): Promise<{ manage: string | null; python: string | null }> {
  const mine = epoch;
  const from = near();
  const manage = await findManage(from);
  const python = (manage && (await call(commands.sdkPythonEffective(dirname(manage))))) || null;
  if (mine === epoch) {
    lookedUpFrom = from;
    useManage.setState({ manage, python });
  }
  return { manage, python };
}

/** Reads the commands of `manage` with `manage.py help`, once (again after a failure only with `retry`). */
export function loadCommands(manage: string, python: string, retry = false): Promise<void> {
  const s = useManage.getState();
  if (s.commands[manage] || (s.failed[manage] && !retry)) return Promise.resolve();
  const pending = reading.get(manage);
  if (pending) return pending;
  const mine = epoch;
  const config = { ...manageConfig(python, manage, ["help"]), id: `django.manage.help:${crypto.randomUUID()}` };
  const read = capture({ ...config, emulateTerminal: false })
    .then(({ out, err }) => {
      if (mine !== epoch) return;
      const list = parseHelp(out);
      useManage.setState((st) => {
        const failed = { ...st.failed };
        delete failed[manage];
        if (list.length) return { commands: { ...st.commands, [manage]: list }, failed };
        return { failed: { ...failed, [manage]: true } };
      });
      if (!list.length)
        notifications().notify({
          level: "warning",
          title: "Cannot list the manage.py commands",
          body: err.trim().split("\n").slice(-5).join("\n") || undefined,
          key: `django.manage.help:${manage}`,
        });
    })
    .catch((e) => console.warn("manage.py help failed", e))
    .finally(() => {
      if (reading.get(manage) === read) reading.delete(manage);
    });
  reading.set(manage, read);
  return read;
}

/**
 * A line typed in a terminal: only where its manage.py sits (elsewhere the shell would not find
 * it), with `python` / `python3` (a versioned one may not be the project's interpreter).
 */
const terminalLine = (line: string, manage: string, terminal: TerminalCommandContext) =>
  dirname(manage) === terminal.cwd && !/^(?:py\b|python[\d.]*\.exe|python(?!3?\s)[\d.])/.test(line.trim());

/** Runs a manage.py line in the Run tool window (not waiting for the command list); false when it isn't one or there's no manage.py. */
export async function runManageLine(
  line: string,
  run: (config: RunConfig) => unknown,
  terminal?: TerminalCommandContext,
): Promise<boolean> {
  const args = manageArgs(line);
  if (!args) return false;
  const { manage, python } = await locateManage();
  if (!manage || !python || (terminal && !terminalLine(line, manage, terminal))) return false;
  // A terminal's active environment (`VIRTUAL_ENV` / `CONDA_PREFIX`) is what its `python` runs.
  const active = terminal ? activePython(terminal.env, usePlatform.getState().os === "windows") : null;
  await run(manageConfig(active ?? python, manage, args));
  return true;
}

/** Commands completing the first word after `manage.py`; nothing once arguments follow. */
export function commandItems(
  query: string,
  list: readonly ManageCommand[],
  run: (line: string) => void,
): RunAnythingItem[] {
  const args = manageArgs(query);
  if (!args || args.length > 1 || (args.length === 1 && /\s$/.test(query))) return [];
  const word = (args[0] ?? "").toLowerCase();
  return list
    .filter((c) => c.name.toLowerCase().includes(word))
    .sort((a, b) => Number(!a.name.startsWith(word)) - Number(!b.name.startsWith(word)) || a.name.localeCompare(b.name))
    .map((c) => ({
      key: c.name,
      label: `${MANAGE} ${c.name}`,
      detail: c.app,
      icon: "file-python",
      completion: `${MANAGE} ${c.name} `,
      run: () => run(`${MANAGE} ${c.name}`),
    }));
}

let locating: Promise<void> | null = null;

export function manageRunAnything(run: (config: RunConfig) => unknown): RunAnythingProvider {
  return {
    id: "django.manage",
    group: "manage.py Tasks",
    order: 25,
    items(query) {
      if (!manageArgs(query)) return [];
      const { manage, python, commands: lists } = useManage.getState();
      if (!manage || !python || near() !== lookedUpFrom) {
        // One lookup at a time while typing; the rows come when it (and `help`) answers.
        locating ??= locateManage()
          .then((at) => void (at.manage && at.python && loadCommands(at.manage, at.python)))
          .finally(() => (locating = null));
      } else void loadCommands(manage, python);
      return commandItems(query, (manage && lists[manage]) || [], (line) => void runManageLine(line, run));
    },
    accepts(line, terminal) {
      if (!manageArgs(line)) return false;
      const { manage } = useManage.getState();
      if (!manage || near() !== lookedUpFrom)
        locating ??= locateManage()
          .then(() => undefined)
          .finally(() => (locating = null));
      return !!manage && (!terminal || terminalLine(line, manage, terminal));
    },
    execute: (line, terminal) => runManageLine(line, run, terminal),
    subscribe: (listener) =>
      useManage.subscribe((s, prev) => (s.commands !== prev.commands || s.manage !== prev.manage) && listener()),
  };
}
