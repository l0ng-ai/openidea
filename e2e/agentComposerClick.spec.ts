import type { Page } from "@playwright/test";
import type { AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "composer-click",
  title: "Composer click task",
  provider: "codex",
  status: "ready",
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
    // These modules must load in the browser's Vite realm, not Playwright's Node process.
    const storePath = "/src/features/agents/store.ts";
    const ipcPath = "/src/platform/ipc.ts";
    const store = await import(storePath);
    const { commands } = await import(ipcPath);
    commands.agentChanges = async () => ({ status: "ok", data: [] });
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
    });
    store.openTask(task.id);
  }, task);
}

// Every row of the text area, down to the toolbar row, puts the caret in the message.
test("clicking anywhere in the composer's text area focuses the message", async ({ workbench: page }) => {
  await openTask(page);
  const box = page.getByRole("textbox", { name: "Message", exact: true }).filter({ visible: true });
  await expect(box).toBeVisible();
  const composer = page.locator("[class*='_composer_']:visible").filter({ has: box });
  const bar = composer.locator("[class*='_bar_']");
  const frame = (await composer.boundingBox())!;
  const barTop = (await bar.boundingBox())!.y;
  const history = page.locator("[class*='_stream_']:visible");
  const missed: number[] = [];
  for (let y = Math.ceil(frame.y) + 1; y < barTop; y++) {
    await history.click({ position: { x: 12, y: 12 } });
    await expect(box).not.toBeFocused();
    await page.mouse.click(frame.x + frame.width / 2, y);
    if (!(await box.evaluate((element) => element === document.activeElement))) missed.push(y - frame.y);
  }
  expect(missed).toEqual([]);
  await page.keyboard.type("typed");
  await expect(box).toHaveText("typed");
});
