/**
 * Agent tasks with long generated conversations, opened as editor tabs: what the
 * performance harness (`perf/`) switches between and scrolls. Dev and perf builds only.
 */
import type { AgentEntry, AgentTask } from "@/bindings";
import { useProject } from "@/platform/project";
import { openTask, useAgents } from "./store";

function task(id: string, title: string, cwd: string): AgentTask {
  return {
    id,
    title,
    provider: "claude",
    model: null,
    status: "ready",
    isolation: "worktree",
    cwd,
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: null,
    updatedMs: null,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

/** A turn as agents work: a request, reasoning, a run of tool calls, then a reply with code. */
function turn(cwd: string, i: number): AgentEntry[] {
  const file = (k: number) => `${cwd}/src/orders/Order${(i + k) % 40}.kt`;
  const tools: AgentEntry[] = Array.from({ length: 10 }, (_, k) => {
    // Tool titles as agents report them (commands and paths, not UI text).
    const command = k % 3 === 2 ? `Edit ${file(k)}` : k % 3 === 1 ? `Read ${file(k)}` : `grep -rn "order${i}" src`;
    return {
      type: "tool",
      id: `tool-${i}-${k}`,
      title: command,
      kind: k % 3 === 2 ? "edit" : k % 3 === 1 ? "read" : "execute",
      status: "completed",
      locations: [],
      output: Array.from(
        { length: 12 },
        (_, l) => `${file(l)}:${l * 7 + 3}:  val order${i} = repository.find(id${l})`,
      ).join("\n"),
      diffs: k % 3 === 2 ? [{ path: file(k), added: 4 + (k % 5), removed: 2 }] : [],
    };
  });
  // What a user and an agent wrote (conversation content, not UI text).
  const request = `Turn ${i}: make the order service retry failed payments and cover it with tests`;
  const reasoning = `The payment client throws on timeouts; retrying belongs in the service (turn ${i}).`;
  return [
    {
      type: "user",
      text: request,
      attachments: [],
      sentMs: null,
      doneMs: null,
    },
    {
      type: "thought",
      text: reasoning,
    },
    ...tools,
    {
      type: "agent",
      text: [
        `## Turn ${i}`,
        "",
        `Payments now retry **three times** with backoff before the order fails. Changed \`OrderService.kt\` and added tests:`,
        "",
        "- `retries` on timeouts, not on declined cards",
        "- waits 200 ms, then 400 ms, then 800 ms",
        "- logs each attempt with the order id",
        "",
        "```kotlin",
        `suspend fun pay${i}(order: Order): Receipt =`,
        "    retry(times = 3, initialDelay = 200.milliseconds) {",
        "        payments.charge(order.id, order.total)",
        "    }",
        "```",
        "",
        "| Case | Before | After |",
        "|---|---|---|",
        "| Timeout | failed | retried |",
        "| Declined | failed | failed |",
      ].join("\n"),
    },
  ];
}

/** Opens `count` tasks of `turns` turns each (14 entries a turn), the last one shown. */
export function openSampleConversations(count: number, turns: number) {
  const cwd = useProject.getState().project?.root ?? "/";
  const entries = Array.from({ length: turns }, (_, i) => turn(cwd, i)).flat();
  const s = useAgents.getState();
  const tasks = new Map(s.tasks);
  const all = new Map(s.entries);
  const ids = Array.from({ length: count }, (_, n) => `sample-${n + 1}`);
  ids.forEach((id, n) => {
    tasks.set(id, task(id, `Sample task ${n + 1}`, cwd));
    all.set(id, entries);
  });
  useAgents.setState({ tasks, entries: all });
  for (const id of ids) openTask(id);
}
