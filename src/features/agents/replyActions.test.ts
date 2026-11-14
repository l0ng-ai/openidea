import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEntry, AgentTask } from "@/bindings";
import { replyOperations, replyTurns } from "./model";
import { replyActions } from "./replyActions";

const backend = vi.hoisted(() => ({
  tasks: new Map<string, AgentTask>(),
  entries: new Map<string, AgentEntry[]>(),
  forkTask: vi.fn(),
  rerunFrom: vi.fn(),
  quoteInComposer: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("./store", () => ({
  useAgents: { getState: () => backend },
  forkTask: backend.forkTask,
  rerunFrom: backend.rerunFrom,
  quoteInComposer: backend.quoteInComposer,
}));
vi.mock("@/workbench/contributions", () => ({ notifications: () => ({ notify: backend.notify }) }));

const prompt: Extract<AgentEntry, { type: "user" }> = {
  type: "user",
  text: "Original request",
  attachments: [],
  sentMs: 0,
  doneMs: 1,
  steered: false,
};
const task: AgentTask = {
  id: "t1",
  title: "Task",
  provider: "codex",
  status: "ready",
  isolation: "local",
  model: null,
  cwd: "/repo",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
  capabilities: { fork: true, rollback: true, steer: true, images: true },
};
const entries: AgentEntry[] = [prompt, { type: "agent", text: "**Answer**" }];
const run = (id: string, arg: unknown = { task: task.id, turn: 0 }) =>
  replyActions.find((action) => action.id === `agents.${id}`)!.run({ ctx: {}, arg });

beforeEach(() => {
  vi.clearAllMocks();
  backend.forkTask.mockResolvedValue(undefined);
  backend.rerunFrom.mockResolvedValue(undefined);
  backend.tasks = new Map([[task.id, task]]);
  backend.entries = new Map([[task.id, entries]]);
});

describe("reply turns", () => {
  it("offers conversation actions only on the final nonempty reply of each turn", () => {
    const result = replyTurns([
      { type: "agent", text: "Unassociated reply" },
      prompt,
      { type: "agent", text: "Progress" },
      { ...prompt, text: "Additional instruction", steered: true },
      { type: "agent", text: "Done" },
      { ...prompt, text: "Next request" },
      { type: "agent", text: "Next answer" },
      { type: "agent", text: " " },
    ]);
    expect([...result].map(([index, reply]) => [index, reply.turn, reply.steered])).toEqual([
      [4, 0, true],
      [6, 1, false],
    ]);
  });

  it.each([
    ["ready", true],
    ["running", false],
    ["starting", false],
    ["needsInput", false],
    ["archived", false],
  ] as const)("enables conversation actions when %s: %s", (status, enabled) => {
    expect(replyOperations({ ...task, status }, { turn: 0, prompt, steered: false }, 1)).toEqual({
      regenerate: enabled,
      fork: enabled,
    });
  });

  it("requires rollback for regeneration and forking earlier turns", () => {
    const older = { turn: 0, prompt, steered: false };
    expect(replyOperations(task, older, 2)).toEqual({ regenerate: false, fork: true });
    const noRollback = { ...task, capabilities: { ...task.capabilities!, rollback: false } };
    expect(replyOperations(noRollback, older, 2)).toEqual({ regenerate: false, fork: false });
    expect(replyOperations(noRollback, older, 1)).toEqual({ regenerate: false, fork: true });
  });
});

it("quotes raw Markdown without sending a prompt", async () => {
  await run("quoteReply", { task: task.id, text: "**Answer**" });
  expect(backend.quoteInComposer).toHaveBeenCalledWith(task.id, "**Answer**");
  expect(backend.rerunFrom).not.toHaveBeenCalled();
  backend.tasks.set(task.id, { ...task, status: "archived" });
  await run("quoteReply", { task: task.id, text: "More" });
  expect(backend.quoteInComposer).toHaveBeenCalledTimes(1);
});

it("regenerates using the original prompt and its images", async () => {
  const image = { mimeType: "image/png", data: "AAA", name: "shot.png" };
  backend.entries.set(task.id, [{ ...prompt, attachments: [image.name], images: [image] }, entries[1]!]);
  await run("regenerateReply");
  expect(backend.rerunFrom).toHaveBeenCalledWith(task.id, 0, prompt.text, [image]);
});

it.each(["files", "steered", "earlier", "busy", "unsupported", "subagent"])(
  "does not replay an invalid request: %s",
  async (kind) => {
    if (kind === "files") backend.entries.set(task.id, [{ ...prompt, attachments: ["main.rs"] }, entries[1]!]);
    if (kind === "steered") backend.entries.set(task.id, [...entries, { ...prompt, steered: true }]);
    if (kind === "earlier") backend.entries.set(task.id, [...entries, prompt, entries[1]!]);
    if (kind === "busy") backend.tasks.set(task.id, { ...task, status: "running" });
    if (kind === "unsupported") backend.tasks.set(task.id, { ...task, capabilities: undefined });
    if (kind === "subagent") backend.entries.set(task.id, [{ type: "agent", text: "Child reply" }]);
    await run("regenerateReply");
    expect(backend.rerunFrom).not.toHaveBeenCalled();
  },
);

it("branches after the reply's turn", async () => {
  await run("forkReply");
  expect(backend.forkTask).toHaveBeenCalledWith(task.id, 1);
});

it("reports regeneration errors and allows retry", async () => {
  backend.rerunFrom.mockRejectedValueOnce(new Error("Unavailable"));
  await run("regenerateReply");
  expect(backend.notify).toHaveBeenCalledWith(
    expect.objectContaining({ level: "error", title: "Couldn't regenerate the response" }),
  );
  await run("regenerateReply");
  expect(backend.rerunFrom).toHaveBeenCalledTimes(2);
});

it("ignores duplicate clicks while regeneration is pending", async () => {
  let finish!: () => void;
  backend.rerunFrom.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const first = run("regenerateReply");
  await run("regenerateReply");
  expect(backend.rerunFrom).toHaveBeenCalledTimes(1);
  finish();
  await first;
});
