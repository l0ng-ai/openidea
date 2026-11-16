/**
 * Generate Commit Message with Agent: the button above the commit message has the agent of the
 * latest task write the message. The agent and git are stubbed at the IPC layer.
 */
import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const PATCH =
  "diff --git a/build.gradle.kts b/build.gradle.kts\n--- a/build.gradle.kts\n+++ b/build.gradle.kts\n@@ -1 +1 @@\n-old\n+new\n";

const option = (category: string, values: string[], current: string) => ({
  id: category,
  name: category,
  description: null,
  category,
  current,
  values: values.map((value) => ({ value, name: value, description: null })),
  via: "option" as const,
});

const TASK = {
  id: "t1",
  title: "Update the build",
  status: "ready" as const,
  isolation: "local" as const,
  provider: "claude",
  model: null,
  cwd: ROOT,
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 5,
  // The user's tasks approve everything; the one that reads the diff must not.
  config: [
    option("model", ["fast", "smart"], "smart"),
    option("mode", ["default", "bypassPermissions"], "bypassPermissions"),
  ],
  commands: [],
  usage: null,
  queue: [],
};

async function stubRepositoryAndAgent(page: Page, reply: string) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, patch, task, reply }) => {
      const changes = [
        {
          path: `${root}/build.gradle.kts`,
          relPath: "build.gradle.kts",
          staged: null,
          unstaged: "modified",
          renamedFrom: null,
        },
        { path: `${root}/notes.txt`, relPath: "notes.txt", staged: null, unstaged: "untracked", renamedFrom: null },
      ];
      const storePath = "/src/features/agents/store.ts";
      const agents = await import(/* @vite-ignore */ storePath);
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [{ root, operation: null, head: "main", headCommit: "1111111" }];
      h.vcs_branch_info = () => ({
        head: "main",
        headCommit: "1111111",
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      h.vcs_status = () => changes;
      h.vcs_create_patch = () => patch;
      h.vcs_log = () => [{ id: "1111111", summary: "Bump the wrapper" }];
      h.agent_create = (args) => {
        const created = { ...task, id: "new", title: "Write a commit message", status: "starting", updatedMs: 9 };
        const request = args.request as { provider: string };
        // The agent ends its turn a moment later, as an event of the task would say.
        setTimeout(() => {
          agents.useAgents.setState((s: { tasks: Map<string, unknown> }) => ({
            tasks: new Map(s.tasks).set("new", { ...created, provider: request.provider, status: "ready" }),
          }));
        }, 300);
        return created;
      };
      h.agent_entries = () => [
        { type: "user", text: "Write a commit message", attachments: [] },
        { type: "agent", text: reply },
      ];
      h.agent_cancel = () => null;
      h.agent_delete = () => null;
      agents.useAgents.setState({
        loaded: true,
        error: null,
        providers: [{ id: "claude", name: "Claude", installed: true, config: [] }],
        tasks: new Map([[task.id, task]]),
        unread: new Set(),
      });
      const vcsModule = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ vcsModule);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root: ROOT, patch: PATCH, task: TASK, reply },
  );
}

test("the agent of the latest task writes the commit message of the included changes", async ({ workbench: page }) => {
  await stubRepositoryAndAgent(page, "```\nUpdate the Gradle build\n\nBump the Kotlin plugin.\n```");
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });
  await expect(message).toHaveValue("");

  await panel.getByRole("button", { name: "Generate Commit Message with Agent" }).click();

  await expect(message).toHaveValue("Update the Gradle build\n\nBump the Kotlin plugin.");
  const [request] = await ipcCalls(page, "agent_create");
  const created = request!.request as {
    provider: string;
    isolation: string;
    config: unknown;
    prompt: { text: string };
  };
  expect(created).toMatchObject({ provider: "claude", isolation: "local" });
  // The model of the latest task, but in the mode that asks before editing or running anything.
  expect(created.config).toEqual([
    { id: "model", value: "smart" },
    { id: "mode", value: "default" },
  ]);
  // Only the included file's diff, and the style of the latest commits, go to the agent.
  expect(created.prompt.text).toContain("+++ b/build.gradle.kts");
  expect(created.prompt.text).toContain("- Bump the wrapper");
  expect(await ipcCalls(page, "vcs_create_patch")).toEqual([
    expect.objectContaining({ source: { from: "changes", paths: [`${ROOT}/build.gradle.kts`], reverse: false } }),
  ]);
  // The task ran for the message only: it is gone again, and nothing was left to read.
  expect(await ipcCalls(page, "agent_delete")).toEqual([expect.objectContaining({ task: "new" })]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a message typed while the agent works is not overwritten", async ({ workbench: page }) => {
  await stubRepositoryAndAgent(page, "Update the Gradle build");
  await page.keyboard.press("Meta+k");
  const panel = page.getByRole("region", { name: "Commit", exact: true });
  const message = panel.getByRole("textbox", { name: "Commit message" });

  await panel.getByRole("button", { name: "Generate Commit Message with Agent" }).click();
  // Once the agent has the changes, the draft they were read for is fixed.
  await expect.poll(async () => (await ipcCalls(page, "agent_create")).length).toBe(1);
  await message.fill("My own message");

  await expect(page.getByText("Commit message not replaced")).toBeVisible();
  await expect(message).toHaveValue("My own message");
});
