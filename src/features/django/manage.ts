/**
 * Run manage.py Task (PyCharm's Tools | Run manage.py Task): `manage.py <command>` lines in
 * Run Anything, with the project's commands from `manage.py help` as completions. The line
 * runs with the project interpreter in a terminal-emulating Run tab, so prompts
 * (`createsuperuser`, `shell`) work.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { parseArgs } from "@/platform/commandLine";
import {
  call,
  commands,
  ideEventsReady,
  onIdeEvent,
  type OutputChunk,
  type RunConfig,
  type RunId,
} from "@/platform/ipc";
import { dirname } from "@/platform/project";
import type { RunAnythingItem, RunAnythingProvider } from "@/workbench/contributions";

export interface ManageCommand {
  name: string;
  /** The app that defines it: `django`, `auth`, `staticfiles`, a project app. */
  app: string;
}

/** The script name, as typed in command lines. */
const MANAGE = "manage.py";

/** `manage.py migrate`, `./manage.py migrate`, `python manage.py migrate`. */
const LINE = /^(?:python3?\s+)?(?:\.\/)?manage\.py(?:\s+|$)/;

/** The arguments after `manage.py`, or null when `line` isn't a manage.py command line. */
export function manageArgs(line: string): string[] | null {
  const head = LINE.exec(line.trim());
  return head ? parseArgs(line.trim().slice(head[0].length)) : null;
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

/** The project's `manage.py`: the shallowest one outside installed packages. */
export function pickManage(paths: readonly string[]): string | null {
  const own = paths.filter((p) => !/\/(?:site-packages|node_modules|\.venv|venv)\//.test(p));
  return own.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0] ?? null;
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
  manage: string | null;
  python: string | null;
  commands: ManageCommand[];
  /** Commands are read once per project, on the first manage.py line. */
  loaded: "no" | "loading" | "yes";
}

export const useManage = create<ManageState>(() => ({ manage: null, python: null, commands: [], loaded: "no" }));

export const resetManage = () => useManage.setState({ manage: null, python: null, commands: [], loaded: "no" });

/** Stdout of a short process on the Run process host (no Run tab). */
async function capture(config: RunConfig, timeoutMs = 30_000): Promise<string> {
  await ideEventsReady();
  let id: RunId | undefined;
  let out = "";
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
  };
  const timer = setTimeout(() => id !== undefined && void call(commands.runStop(id)).catch(() => {}), timeoutMs);
  try {
    id = (await call(commands.runStart(config, channel, null))).id;
    if (exits.has(id)) finish();
    await exited;
    return out;
  } finally {
    clearTimeout(timer);
    off();
  }
}

/** The project's manage.py and the interpreter it runs with. */
export async function locateManage(): Promise<{ manage: string | null; python: string | null }> {
  const manage = pickManage((await call(commands.findFilesNamed("manage.py"))).map(String));
  const python = manage && (await call(commands.sdkPythonEffective(dirname(manage))));
  return { manage, python: python || null };
}

/** Finds manage.py and the interpreter, then lists the commands (each once per project). */
export async function loadManage(): Promise<void> {
  if (useManage.getState().loaded !== "no") return;
  useManage.setState({ loaded: "loading" });
  try {
    const { manage, python } = await locateManage();
    useManage.setState({ manage, python });
    if (manage && python) {
      const config = { ...manageConfig(python, manage, ["help"]), id: `django.manage.help:${crypto.randomUUID()}` };
      useManage.setState({ commands: parseHelp(await capture({ ...config, emulateTerminal: false })) });
    }
  } catch (e) {
    console.warn("manage.py help failed", e);
  } finally {
    if (useManage.getState().loaded === "loading") useManage.setState({ loaded: "yes" });
  }
}

/** Runs a manage.py line in the Run tool window; false when it isn't one or there's no manage.py. */
export async function runManageLine(line: string, run: (config: RunConfig) => unknown): Promise<boolean> {
  const args = manageArgs(line);
  if (!args) return false;
  await loadManage();
  const { manage, python } = useManage.getState();
  if (!manage || !python) return false;
  await run(manageConfig(python, manage, args));
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

export function manageRunAnything(run: (config: RunConfig) => unknown): RunAnythingProvider {
  return {
    id: "django.manage",
    group: "manage.py Tasks",
    order: 25,
    items(query) {
      if (!manageArgs(query)) return [];
      void loadManage();
      return commandItems(query, useManage.getState().commands, (line) => void runManageLine(line, run));
    },
    execute: (line) => runManageLine(line, run),
    subscribe: (listener) => useManage.subscribe((s, prev) => s.commands !== prev.commands && listener()),
  };
}
