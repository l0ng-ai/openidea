/**
 * Terminal sessions as editor-area tabs (#2202), IDEA's Move to Editor: a tab of the
 * Terminal tool window moves into the editor area with its session still running, so a
 * full-screen CLI (Claude Code, Codex…) gets the editor's room. This module is the
 * xterm-free part: the input kind and the session snapshot store the tab strip reads.
 * The sessions themselves live in `cliSessions.ts`, behind the terminal runtime.
 */
import { create } from "zustand";
import { editorService, toolWindowService, type EditorInput } from "@/workbench/contributions";
import { useProject } from "@/platform/project";
import { loadTerminalRuntime } from "./loader";
import type { SessionSnapshot } from "./session";

/** Editor kind of a terminal session tab. */
export const CLI_KIND = "cli";

/** `data` of a terminal editor tab: its title and where it started. */
export interface CliData {
  name: string;
  /** Run as the shell's first input when a restored tab is started; empty: a plain shell. */
  command: string;
  /** The session's directory when it was saved; a restored tab starts there. */
  cwd?: string;
}

/** `data` arrives from the saved editor session: treat it as untrusted JSON. */
export function cliData(input: EditorInput): CliData | null {
  if (input.kind !== CLI_KIND) return null;
  const d = input.data as Partial<CliData> | undefined;
  if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
  return {
    name: d.name.trim(),
    command: typeof d.command === "string" ? d.command.trim() : "",
    ...(typeof d.cwd === "string" && d.cwd ? { cwd: d.cwd } : {}),
  };
}

let seq = 0;
/** A fresh input for one session; keys never repeat, so a restored tab is its own. */
export function cliInput(name: string, command: string, cwd?: string): EditorInput {
  return {
    kind: CLI_KIND,
    key: `cli:r${++seq}-${Date.now().toString(36)}`,
    data: { name, command, ...(cwd ? { cwd } : {}) },
  };
}

/** Snapshots of the live editor sessions, by editor input key (an empty record: no live tab). */
export const useClis = create<{ sessions: Record<string, SessionSnapshot> }>(() => ({ sessions: {} }));

/**
 * Move to Editor: tab `id` of the Terminal tool window (the active one when omitted)
 * leaves the tool window and opens as an editor tab, its session still running.
 */
export async function moveTerminalToEditor(id?: string) {
  const rt = await loadTerminalRuntime();
  const state = rt.useTerminals.getState();
  const tab = state.tabs.find((t) => t.id === (id ?? state.activeTab));
  if (!tab) return;
  const name = rt.tabTitle(tab, state.sessions);
  const session = rt.detachTab(tab.id);
  if (!session) return;
  const input = cliInput(name, "", session.state.cwd ?? undefined);
  rt.adoptCli(input.key, session);
  if (rt.useTerminals.getState().tabs.length === 0) toolWindowService().hide("terminal");
  await editorService().openInput(input, { focus: true });
}

/** Starts the session of a restored tab: its Start button. */
export async function startTab(input: EditorInput) {
  const data = cliData(input);
  const root = useProject.getState().project?.root;
  if (!data || !root) return;
  const rt = await loadTerminalRuntime();
  rt.startCli(input.key, data.cwd ?? root, data.command, root);
}
