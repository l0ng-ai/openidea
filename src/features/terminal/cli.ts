/**
 * Full-size agent CLIs (Claude Code, Codex, aider…) as editor-area tabs (#2202):
 * each tab is a terminal session of the user's login shell that runs one saved
 * command first. This module is the xterm-free part: input kinds, the session
 * snapshot store the tab strip reads, and the saved CLIs (global, all projects).
 * The sessions themselves live in `cliSessions.ts`, behind the terminal runtime.
 */
import { create } from "zustand";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { loadTerminalRuntime } from "./loader";
import type { SessionSnapshot } from "./session";

/** Editor kind of a CLI session tab. */
export const CLI_KIND = "cli";
/** Editor kind of the New CLI launcher tab. */
export const CLI_LAUNCHER_KIND = "cli.launcher";
/** Key of the one launcher tab. */
export const CLI_LAUNCHER_KEY = "cli:launcher";

/** `data` of a CLI session tab: what the tab runs and what it is called. */
export interface CliData {
  name: string;
  command: string;
}

/** `data` arrives from the saved editor session: treat it as untrusted JSON. */
export function cliData(input: EditorInput): CliData | null {
  if (input.kind !== CLI_KIND) return null;
  const d = input.data as Partial<CliData> | undefined;
  if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
  return { name: d.name.trim(), command: typeof d.command === "string" ? d.command.trim() : "" };
}

let seq = 0;
/** A fresh input for one CLI run; keys never repeat, so a restored tab is its own. */
export function cliInput(name: string, command: string): EditorInput {
  return { kind: CLI_KIND, key: `cli:r${++seq}-${Date.now().toString(36)}`, data: { name, command } };
}

/** Snapshots of the live CLI sessions, by editor input key (an empty record: no live tab). */
export const useClis = create<{ sessions: Record<string, SessionSnapshot> }>(() => ({ sessions: {} }));

/** A saved CLI: one launcher card. */
export interface SavedCli {
  id: string;
  name: string;
  command: string;
}

const SAVED_PREFIX = "openidea.cli.saved.v1:";
const MAX_SAVED = 32;

export function readSavedClis(): SavedCli[] {
  try {
    return decodeSavedClis(JSON.parse(localStorage.getItem(SAVED_PREFIX) ?? "null"));
  } catch {
    return [];
  }
}

export function writeSavedClis(saved: SavedCli[]) {
  try {
    localStorage.setItem(SAVED_PREFIX, JSON.stringify(saved));
  } catch {
    /* storage unavailable or full: the launcher just forgets the addition */
  }
}

/** Validates untrusted JSON; returns null when unusable. */
export function decodeSavedClis(raw: unknown): SavedCli[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedCli[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_SAVED)) {
    if (!item || typeof item !== "object") continue;
    const v = item as Partial<SavedCli>;
    if (typeof v.id !== "string" || !v.id || ids.has(v.id)) continue;
    if (typeof v.name !== "string" || !v.name.trim() || typeof v.command !== "string" || !v.command.trim()) continue;
    ids.add(v.id);
    out.push({ id: v.id, name: v.name.trim(), command: v.command.trim() });
  }
  return out;
}

export const useSavedClis = create<{ saved: SavedCli[] }>(() => ({ saved: readSavedClis() }));

let savedSeq = 0;

/** Saves `name` + `command` for every project; returns the new entry. */
export function saveCli(name: string, command: string): SavedCli {
  const saved: SavedCli = {
    id: `cli-s${++savedSeq}-${Date.now().toString(36)}`,
    name: name.trim(),
    command: command.trim(),
  };
  const next = [...useSavedClis.getState().saved, saved];
  useSavedClis.setState({ saved: next });
  writeSavedClis(next);
  return saved;
}

export function removeSavedCli(id: string) {
  const next = useSavedClis.getState().saved.filter((s) => s.id !== id);
  useSavedClis.setState({ saved: next });
  writeSavedClis(next);
}

/** Opens the New CLI launcher tab. */
export async function openCliLauncher() {
  await editorService().openInput({ kind: CLI_LAUNCHER_KIND, key: CLI_LAUNCHER_KEY, data: {} }, { focus: true });
}

/**
 * Starts a CLI in a new editor tab: the login shell of the project directory
 * runs `command` as its first input. The launcher tab, if open, makes way for it.
 */
export async function launchCli(name: string, command: string) {
  const root = useProject.getState().project?.root;
  if (!root) return;
  const rt = await loadTerminalRuntime();
  const input = cliInput(name, command);
  rt.startCli(input.key, root, command);
  await editorService().openInput(input, { focus: true });
  await editorService().closeInput?.(CLI_LAUNCHER_KEY);
}

/** Starts (or resumes) the CLI of an open tab: the Start button of a restored tab. */
export async function startTab(input: EditorInput) {
  const data = cliData(input);
  const root = useProject.getState().project?.root;
  if (!data || !root) return;
  const rt = await loadTerminalRuntime();
  rt.startCli(input.key, root, data.command);
}
