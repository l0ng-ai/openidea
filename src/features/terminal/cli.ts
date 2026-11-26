/**
 * Terminal sessions as editor-area tabs (#2202), IDEA's Move to Editor: a tab of the
 * Terminal tool window moves into the editor area with its session still running, so a
 * full-screen CLI (Claude Code, Codex…) gets the editor's room. This module is the
 * xterm-free part: the input kind and the session snapshot store the tab strip reads.
 * The sessions themselves live in `cliSessions.ts`, behind the terminal runtime.
 */
import { createElement } from "react";
import { create } from "zustand";
import {
  editorService,
  maybeEditorService,
  toolWindowService,
  type EditorDropTarget,
  type EditorInput,
} from "@/workbench/contributions";
import { useTx } from "@/platform/i18n";
import { basename, useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { workflowSettings } from "@/platform/workflowSettings";
import { Badge } from "@/ui";
import { loadTerminalRuntime } from "./loader";
import type { SessionSnapshot } from "./session";
import type { TerminalDropTarget } from "./store";

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
  /** Default tab name beneath `customName`, preserved when moving back to Terminal. */
  baseName?: string;
  /** User rename preserved when moving back to Terminal. */
  customName?: string;
  /** Predefined shell path preserved when moving back to Terminal. */
  shell?: string;
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
    ...(typeof d.baseName === "string" && d.baseName.trim() ? { baseName: d.baseName.trim() } : {}),
    ...(typeof d.customName === "string" && d.customName.trim() ? { customName: d.customName.trim() } : {}),
    ...(typeof d.shell === "string" && d.shell ? { shell: d.shell } : {}),
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
  if (tab.customName || tab.shell) {
    Object.assign(input.data as CliData, {
      ...(tab.customName ? { baseName: tab.name, customName: tab.customName } : {}),
      ...(tab.shell ? { shell: tab.shell } : {}),
    });
  }
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

function nextCliTabName(rt: Awaited<ReturnType<typeof loadTerminalRuntime>>, base?: string): string {
  const openNames =
    maybeEditorService()
      ?.openTabs?.()
      .flatMap((t) => (t.input.kind === CLI_KIND ? [cliData(t.input)?.name ?? t.title] : [])) ?? [];
  return rt.nextTabName(
    [...rt.useTerminals.getState().tabs.map((t) => t.name), ...openNames],
    base ?? workflowSettings().terminal.tabName,
  );
}

/** Opens a fresh terminal session as a tab in the active editor pane. */
export async function openNewTerminalInEditor(dir?: string): Promise<void> {
  const root = useProject.getState().project?.root;
  const fallbackRoot = root ?? dir;
  if (!fallbackRoot) return;
  const rt = await loadTerminalRuntime();
  const cwd = dir || rt.startDirectory(fallbackRoot);
  const name = nextCliTabName(rt, dir ? basename(dir) || undefined : undefined);
  const fresh = cliInput(name, "", cwd);
  rt.startCli(fresh.key, cwd, "", fallbackRoot);
  trackCliTerminalId(fresh);
  await editorService().openInput(fresh, { focus: true });
}

/** Splits a terminal editor tab into a new shell session in the same directory. */
export async function splitCliTab(input: EditorInput): Promise<EditorInput | null> {
  const root = useProject.getState().project?.root;
  if (!root) return null;
  const rt = await loadTerminalRuntime();
  const cwd = rt.cliSession(input.key)?.state.cwd || cliData(input)?.cwd || rt.startDirectory(root);
  const name = nextCliTabName(rt);
  const fresh = cliInput(name, "", cwd);
  rt.startCli(fresh.key, cwd, "", root);
  trackCliTerminalId(fresh);
  return fresh;
}

/** Resolves an `EDITOR_TAB_MIME` drag payload when it points to a terminal (`cli`) editor tab. */
export function cliEditorPayload(raw: string): EditorInput | null {
  try {
    const p = JSON.parse(raw) as { paneId?: unknown; tabId?: unknown };
    if (typeof p.paneId !== "string" || typeof p.tabId !== "string") return null;
    const input = maybeEditorService()?.tabInput?.(p.paneId, p.tabId) ?? null;
    return input?.kind === CLI_KIND ? input : null;
  } catch {
    return null;
  }
}

/**
 * Move to Terminal: a terminal editor tab (`keyOrInput`, or the active editor tab when omitted)
 * leaves the editor and docks in the Terminal tool window with its running session intact.
 */
export async function moveEditorToTerminal(keyOrInput?: string | EditorInput, target?: TerminalDropTarget) {
  const svc = maybeEditorService();
  if (!svc) return;
  const input =
    typeof keyOrInput === "object" && keyOrInput !== null
      ? keyOrInput
      : typeof keyOrInput === "string" && keyOrInput
        ? (svc.openTabs?.().find((t) => t.input.key === keyOrInput)?.input ??
          (svc.activeInput?.()?.key === keyOrInput ? svc.activeInput() : null))
        : (svc.activeInput?.() ?? null);
  const data = input ? cliData(input) : null;
  if (!input || !data) return;
  const rt = await loadTerminalRuntime();
  let session = rt.detachCli(input.key);
  if (!session) {
    const root = useProject.getState().project?.root;
    if (!root) return;
    session = rt.createDetachedSession(data.cwd ?? rt.startDirectory(root), data.shell, root);
    if (data.command) session.input(`${data.command}\r`);
  }
  const closed = await (svc.closeInput?.(input.key) ?? Promise.resolve(true));
  if (!closed) {
    rt.adoptCli(input.key, session);
    return;
  }
  rt.adoptTab(
    session,
    {
      name: data.baseName ?? data.name,
      customName: data.customName ?? null,
      shell: data.shell ?? null,
    },
    target,
  );
  toolWindowService().show("terminal", true);
  requestAnimationFrame(() => requestAnimationFrame(() => rt.activeSession()?.focus()));
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
