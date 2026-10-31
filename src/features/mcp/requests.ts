/**
 * What the built-in MCP server asks this window (`mcpRequest`): confirmations
 * before a tool runs something, shown one at a time while later ones wait, and
 * editor requests answered at once (open a file, list the open editors).
 */
import { create } from "zustand";
import { commands, type McpAnswer, type McpUiRequest } from "@/platform/ipc";
import { isVirtualUri } from "@/platform/virtualDocs";
import { editorService, type EditorService } from "@/workbench/contributions";

export type McpConfirmRequest = Extract<McpUiRequest, { type: "confirm" }>;

export interface McpConfirm extends Omit<McpConfirmRequest, "type"> {
  id: number;
}

export type Respond = (id: number, answer: McpAnswer) => Promise<void>;

const respondToBackend: Respond = (id, answer) => commands.mcpRespond(id, answer);

export const useMcpConfirms = create<{ queue: McpConfirm[] }>(() => ({ queue: [] }));

export function enqueueConfirm(c: McpConfirm) {
  useMcpConfirms.setState((s) => (s.queue.some((q) => q.id === c.id) ? s : { queue: [...s.queue, c] }));
}

/** Drops request `id` (answered, timed out or cancelled by the client). */
export function dropConfirm(id: number) {
  useMcpConfirms.setState((s) =>
    s.queue.some((q) => q.id === id) ? { queue: s.queue.filter((q) => q.id !== id) } : s,
  );
}

export function answerConfirm(c: McpConfirm, allow: boolean, respond: Respond = respondToBackend) {
  dropConfirm(c.id);
  void respond(c.id, { type: "confirm", allow }).catch(() => {});
}

const failure = (e: unknown): McpAnswer => ({
  type: "failed",
  message: e instanceof Error ? e.message : String(e),
});

/** Paths an MCP client can use: files on disk, not virtual documents (diffs, library sources). */
const onDisk = (path: string | null | undefined): path is string => !!path && !isVirtualUri(path);

/** The open editors as `openEditors` answers them: the active file and every open file tab. */
export function openEditors(editor: EditorService): McpAnswer {
  const active = editor.activePath();
  return {
    type: "openEditors",
    editors: { active: onDisk(active) ? active : null, open: (editor.openPaths?.() ?? []).filter(onDisk) },
  };
}

/** Opens `path` focused, with the caret at the 1-based `line` / `column` (the editor counts from 0). */
export async function openFile(
  editor: EditorService,
  request: Extract<McpUiRequest, { type: "openFile" }>,
): Promise<McpAnswer> {
  const { path, line, column } = request;
  const selection = line != null && line > 0 ? { line: line - 1, col: Math.max(0, (column ?? 1) - 1) } : undefined;
  await editor.openFile(path, { selection, focus: true });
  return { type: "done" };
}

/** Handles one `mcpRequest`: queues a confirmation, or does the editor request and answers it. */
export async function handleMcpRequest(
  id: number,
  request: McpUiRequest,
  respond: Respond = respondToBackend,
  editor: () => EditorService = editorService,
): Promise<void> {
  if (request.type === "confirm") {
    const { client, tool, subject, detail } = request;
    enqueueConfirm({ id, client, tool, subject, detail });
    return;
  }
  let answer: McpAnswer;
  try {
    answer = request.type === "openFile" ? await openFile(editor(), request) : openEditors(editor());
  } catch (e) {
    answer = failure(e);
  }
  await respond(id, answer).catch(() => {});
}
