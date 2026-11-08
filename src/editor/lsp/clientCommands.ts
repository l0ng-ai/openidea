/**
 * Commands of code lenses and inlay hint parts that the client runs itself
 * (the Laravel route actions), by name. A command no client handler knows
 * goes to the language server (`workspace/executeCommand`).
 */
import type { EditorView } from "@codemirror/view";
import { commands, type Command } from "@/platform/ipc";
import { docOf, lspRequest } from "./lsp";

export interface ClientCommandContext {
  view: EditorView;
  /** The click that ran it (menus open there). */
  event?: MouseEvent;
}

export type ClientCommandHandler = (args: readonly unknown[], ctx: ClientCommandContext) => void | Promise<void>;

const handlers = new Map<string, ClientCommandHandler>();

/** Runs `name` in the client instead of the language server. */
export function registerClientCommand(name: string, handler: ClientCommandHandler): () => void {
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

/** Whether the client runs `command` itself (a code action carrying it opens a client dialog). */
export function isClientCommand(command: Command | null | undefined): command is Command {
  return !!command && handlers.has(command.command);
}

/** Runs a lens's or hint's command: a client handler, else the document's language server. */
export async function runCommand(view: EditorView, command: Command, event?: MouseEvent): Promise<void> {
  const handler = handlers.get(command.command);
  if (handler) {
    await handler(command.arguments ?? [], { view, event });
    return;
  }
  const doc = docOf(view);
  if (!doc) return;
  await lspRequest(() => commands.lspExecuteCommand(doc.doc, command)).catch(() => undefined);
}
