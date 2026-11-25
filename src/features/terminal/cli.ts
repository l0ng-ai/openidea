/**
 * Terminal sessions as editor-area tabs (#2202), IDEA's Move to Editor: a tab of the
 * Terminal tool window moves into the editor area with its session still running, so a
 * full-screen CLI (Claude Code, Codex…) gets the editor's room. This module is the
 * xterm-free part: the input kind and the session snapshot store the tab strip reads.
 * The sessions themselves live in `cliSessions.ts`, behind the terminal runtime.
 */
import { createElement } from "react";
import { create } from "zustand";
import { editorService, toolWindowService, type EditorDropTarget, type EditorInput } from "@/workbench/contributions";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { workflowSettings } from "@/platform/workflowSettings";
import { Badge } from "@/ui";
import { loadTerminalRuntime } from "./loader";
import type { SessionSnapshot } from "./session";

/** Editor kind of a terminal session tab. */
export const CLI_KIND = "cli";

/** Drag type of terminal tabs: reorders within the tool window, or drops onto the editor area. */
export const TERMINAL_TAB_MIME = "application/x-openidea-terminal-tab";

/** `data` of a terminal editor tab: its title and where it started. */
export interface CliData {
  name: string;
  /** Run as the shell's first input when a restored tab is started; empty: a plain shell. */
  command: string;
  /** The session's directory when it was saved; a restored tab starts there. */
  cwd?: string;
  /** Live backend PTY id in a persistent remote session. */
  terminalId?: number;
}

/** `data` arrives from the saved editor session: treat it as untrusted JSON. */
export function cliData(input: EditorInput): CliData | null {
  if (input.kind !== CLI_KIND) return null;
  const d = input.data as Partial<CliData> | undefined;
  if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
  const terminalId =
    typeof d.terminalId === "number" && Number.isInteger(d.terminalId) && d.terminalId > 0 ? d.terminalId : undefined;
  return {
    name: d.name.trim(),
    command: typeof d.command === "string" ? d.command.trim() : "",
    ...(typeof d.cwd === "string" && d.cwd ? { cwd: d.cwd } : {}),
    ...(terminalId !== undefined ? { terminalId } : {}),
  };
}

let seq = 0;
/** A fresh input for one session; keys never repeat, so a restored tab is its own. */
export function cliInput(name: string, command: string, cwd?: string, terminalId?: number): EditorInput {
  return {
    kind: CLI_KIND,
    key: `cli:r${++seq}-${Date.now().toString(36)}`,
    data: {
      name,
      command,
      ...(cwd ? { cwd } : {}),
      ...(terminalId !== undefined ? { terminalId } : {}),
    },
  };
}

/** Snapshots of the live editor sessions, by editor input key (an empty record: no live tab). */
export const useClis = create<{ sessions: Record<string, SessionSnapshot> }>(() => ({ sessions: {} }));

/** The editor tab's unseen-completion dot (#3712): a finished command, not seen yet. */
export function CliDoneMark({ inputKey }: { inputKey: string }) {
  const unseen = useClis((s) => !!s.sessions[inputKey]?.unseenDone);
  const tx = useTx();
  if (!unseen) return null;
  return createElement(Badge, { dot: true, tone: "accent", children: tx("Finished") });
}

/** Keeps `input.data.terminalId` in sync once the session's PTY spawns, so saved editor sessions can reattach. */
function trackCliTerminalId(input: EditorInput) {
  if (!input.data || typeof input.data !== "object") return;
  const apply = (tid: number | null | undefined) => {
    if (tid != null) {
      (input.data as CliData).terminalId = tid;
      return true;
    }
    return false;
  };
  if (apply(useClis.getState().sessions[input.key]?.terminalId)) return;
  const off = useClis.subscribe((s) => {
    const snap = s.sessions[input.key];
    if (apply(snap?.terminalId) || snap?.status === "exited" || snap?.status === "error") off();
  });
}

/**
 * Move to Editor: tab `id` of the Terminal tool window (the active one when omitted)
 * leaves the tool window and opens as an editor tab, its session still running.
 */
export async function moveTerminalToEditor(id?: string, target?: EditorDropTarget) {
  const rt = await loadTerminalRuntime();
  const state = rt.useTerminals.getState();
  const tab = state.tabs.find((t) => t.id === (id ?? state.activeTab));
  if (!tab) return;
  const name = rt.tabTitle(tab, state.sessions);
  const session = rt.detachTab(tab.id);
  if (!session) return;
  const tid = session.persistedTerminalId ?? session.state.terminalId ?? undefined;
  const input = cliInput(name, "", session.state.cwd ?? undefined, tid);
  rt.adoptCli(input.key, session);
  trackCliTerminalId(input);
  if (rt.useTerminals.getState().tabs.length === 0) toolWindowService().hide("terminal");
  await editorService().openInput(input, {
    focus: true,
    ...(target
      ? {
          pane: target.paneId,
          ...(target.zone !== "center" ? { edge: target.zone } : {}),
          ...(target.index !== undefined ? { index: target.index } : {}),
          ...(target.pinned !== undefined ? { pinned: target.pinned } : {}),
        }
      : {}),
  });
}

/** Splits a terminal editor tab into a new shell session in the same directory. */
export async function splitCliTab(input: EditorInput): Promise<EditorInput | null> {
  const root = useProject.getState().project?.root;
  if (!root) return null;
  const rt = await loadTerminalRuntime();
  const cwd = rt.cliSession(input.key)?.state.cwd || cliData(input)?.cwd || rt.startDirectory(root);
  const openNames =
    editorService()
      .openTabs?.()
      .flatMap((t) => (t.input.kind === CLI_KIND ? [cliData(t.input)?.name ?? t.title] : [])) ?? [];
  const name = rt.nextTabName(
    [...rt.useTerminals.getState().tabs.map((t) => t.name), ...openNames],
    workflowSettings().terminal.tabName,
  );
  const fresh = cliInput(name, "", cwd);
  rt.startCli(fresh.key, cwd, "", root);
  trackCliTerminalId(fresh);
  return fresh;
}

/** Starts the session of a restored tab: its Start button. */
export async function startTab(input: EditorInput) {
  const data = cliData(input);
  const root = useProject.getState().project?.root;
  if (!data || !root) return;
  const rt = await loadTerminalRuntime();
  rt.startCli(input.key, data.cwd ?? root, data.command, root);
  trackCliTerminalId(input);
}

/** Reattaches a restored CLI editor tab to its live remote PTY, when still running. */
export async function reattachCliTab(input: EditorInput) {
  if (!isRemoteWindow()) return;
  const data = cliData(input);
  const root = useProject.getState().project?.root;
  if (!data?.terminalId || !root) return;
  const rt = await loadTerminalRuntime();
  const ok = await rt.reattachCli(input.key, data.terminalId, data.cwd ?? root, root);
  if (!ok && input.data && typeof input.data === "object") {
    delete (input.data as CliData).terminalId;
  }
}
