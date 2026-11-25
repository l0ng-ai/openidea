import type { Page } from "@playwright/test";
import type { AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "status-fit",
  title: "Status fit task",
  provider: "codex",
  status: "failed",
  isolation: "local",
  model: null,
  cwd: "/dev/acme-api",
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
};

async function openTask(page: Page) {
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const ipcPath = "/src/platform/ipc.ts";
    const store = await import(storePath);
    const { commands } = await import(ipcPath);
    const change = (relPath: string) => ({
      path: `/dev/acme-api/${relPath}`,
      relPath,
      kind: "modified",
      added: 4,
      removed: 1,
      oldPath: null,
      repo: null,
    });
    const files = [change("a.ts"), change("b.ts"), change("c.ts")];
    // A local task lists its files against HEAD.
    commands.agentChanges = async () => ({ status: "ok", data: files });
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      entries: new Map([[task.id, [{ type: "agent", text: "Reply" }]]]),
      composers: new Map(),
      unread: new Set(),
      docked: null,
      homeOpen: false,
      sessionLocation: "editor",
      changes: new Map([[task.id, files]]),
    });
    store.openTask(task.id);
  }, task);
}

test("the session status strip fits a narrow session instead of truncating everything", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await openTask(page);
  const strip = page.locator("[class*='_statusBar_']:visible");
  const provider = strip.getByText("codex", { exact: true });
  const chip = strip.getByRole("button", { name: /3 changed files/ });
  const state = strip.getByText("Failed", { exact: true });
  await expect(chip).toBeVisible();
  await expect(provider).toBeVisible();
  await expect(state).toBeVisible();
  await expect(chip.getByText("3 changed files")).toBeVisible();

  // Narrow: the icon stands for the provider, the count for the label (the tooltips keep both).
  await page.setViewportSize({ width: 860, height: 800 });
  const width = () =>
    strip.evaluate((el) => el.closest("[class*='_conversation_']")?.getBoundingClientRect().width ?? 0);
  await expect.poll(width).toBeLessThanOrEqual(560);
  await expect(provider).toBeHidden();
  await expect(chip).toHaveAttribute("title", "3 changed files");
  await expect(chip.getByText("3", { exact: true })).toBeVisible();
  await expect(chip.getByText("+12")).toBeVisible();

  // Narrower still: the task's state, shown by the composer and the conversation, gives way.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(width).toBeLessThanOrEqual(420);
  await expect(state).toBeHidden();
  await expect(chip).toBeVisible();
  const box = (await strip.boundingBox())!;
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(box.x + box.width);
});
