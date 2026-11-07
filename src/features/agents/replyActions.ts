import type { Action } from "@/platform/actions";
import { notifications } from "@/workbench/contributions";
import { replyOperations, replyTurns, turnNumbers } from "./model";
import { forkTask, quoteInComposer, rerunFrom, useAgents } from "./store";

export interface CopyReply {
  text: string;
  onCopied?: () => void;
}

export const copyReplyAction: Action = {
  id: "agents.copyReplyMarkdown",
  title: "Copy Markdown",
  category: "Agents",
  icon: "copy",
  hidden: true,
  run: async ({ arg }) => {
    const reply = arg as CopyReply | undefined;
    if (!reply || typeof reply.text !== "string" || !reply.text.trim()) return;
    try {
      await navigator.clipboard.writeText(reply.text);
      reply.onCopied?.();
    } catch (e) {
      notifications().notify({ level: "error", title: "Couldn't copy the reply", body: String(e) });
    }
  },
};

interface ReplyTarget {
  task: string;
  turn: number;
}

function resolveReply(arg: unknown) {
  const target = arg as ReplyTarget | undefined;
  if (!target || typeof target.task !== "string" || !Number.isInteger(target.turn)) return null;
  const task = useAgents.getState().tasks.get(target.task);
  const entries = useAgents.getState().entries.get(target.task);
  if (!task || !entries) return null;
  const reply = [...replyTurns(entries).values()].find((r) => r.turn === target.turn);
  if (!reply) return null;
  return { task, reply, operations: replyOperations(task, reply, turnNumbers(entries).size) };
}

const pending = new Set<string>();
async function runReplyOperation(task: string, title: string, run: () => Promise<void>) {
  if (pending.has(task)) return;
  pending.add(task);
  try {
    await run();
  } catch (e) {
    notifications().notify({ level: "error", title, body: String(e) });
  } finally {
    pending.delete(task);
  }
}

export const replyActions: Action[] = [
  copyReplyAction,
  {
    id: "agents.quoteReply",
    title: "Quote Reply",
    category: "Agents",
    icon: "quote",
    hidden: true,
    run: ({ arg }) => {
      const target = arg as { task: string; text: string } | undefined;
      if (!target || typeof target.text !== "string" || !target.text.trim()) return;
      const task = useAgents.getState().tasks.get(target.task);
      if (task && task.status !== "archived") quoteInComposer(task.id, target.text);
    },
  },
  {
    id: "agents.regenerateReply",
    title: "Regenerate Response",
    category: "Agents",
    icon: "refresh",
    hidden: true,
    run: ({ arg }) => {
      const resolved = resolveReply(arg);
      if (!resolved?.operations.regenerate) return;
      const { task, reply } = resolved;
      return runReplyOperation(task.id, "Couldn't regenerate the response", () =>
        rerunFrom(task.id, reply.turn, reply.prompt.text, reply.prompt.images ?? []),
      );
    },
  },
  {
    id: "agents.forkReply",
    title: "Branch Conversation from Here",
    category: "Agents",
    icon: "branch",
    hidden: true,
    run: ({ arg }) => {
      const resolved = resolveReply(arg);
      if (!resolved?.operations.fork) return;
      const { task, reply } = resolved;
      return runReplyOperation(task.id, "Couldn't copy the task", () => forkTask(task.id, reply.turn + 1));
    },
  },
];
