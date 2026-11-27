import type { Locator, Page } from "@playwright/test";
import type { AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "composer-popup",
  title: "Composer popup task",
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

async function openTask(page: Page, delayFiles = false) {
  await page.evaluate(
    async ({ task, delayFiles }) => {
      // Load the workbench modules in Vite's browser realm, not the Playwright runner.
      const storePath = "/src/features/agents/store.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const store = await import(storePath);
      const { commands } = await import(ipcPath);
      const { promise: filesReady, resolve } = Promise.withResolvers<void>();
      if (delayFiles) window.addEventListener("test:release-composer-files", () => resolve(), { once: true });
      else resolve();
      const file = (name: string) => ({ path: `${task.cwd}/${name}`, relPath: name, score: 1, indices: [] });
      commands.agentChanges = async () => ({ status: "ok", data: [] });
      commands.findFiles = async (query: string) => {
        if (!query) await filesReady;
        return {
          status: "ok",
          data: query ? [file("a.ts")] : Array.from({ length: 12 }, (_, i) => file(`file${i}.ts`)),
        };
      };
      commands.findDirs = async () => ({ status: "ok", data: [] });
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
    },
    { task, delayFiles },
  );
  const editor = page.getByRole("textbox", { name: "Message", exact: true });
  await editor.click();
  return { editor, list: page.getByRole("listbox", { name: "Files", exact: true }) };
}

function geometry(list: Locator) {
  return list.evaluate((list) => {
    const popup = list.closest<HTMLElement>("[data-popup]")!;
    const rect = popup.getBoundingClientRect();
    const caret = getSelection()!.getRangeAt(0).getBoundingClientRect();
    const footer = popup.querySelector("span:last-child > kbd")!.getBoundingClientRect();
    return {
      side: rect.bottom <= caret.top ? "above" : rect.top >= caret.bottom ? "below" : "overlap",
      height: popup.offsetHeight,
      listHeight: list.clientHeight,
      inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
      footerVisible: footer.height > 0 && footer.top >= rect.top && footer.bottom <= rect.bottom,
    };
  });
}

const fullList = { side: "above", listHeight: 300, inViewport: true, footerVisible: true };

test("erasing the @ filter restores the popup's fitting side and height", async ({ workbench: page }) => {
  const { editor, list } = await openTask(page);
  await editor.pressSequentially("@");
  await expect(list.getByText("file0.ts", { exact: true })).toBeVisible();
  await expect.poll(() => geometry(list)).toMatchObject(fullList);
  const initial = await geometry(list);

  await editor.pressSequentially("a");
  await expect(list.getByText("a.ts", { exact: true })).toBeVisible();
  await expect.poll(() => geometry(list)).toMatchObject({ side: "below", footerVisible: true });
  await editor.press("Backspace");
  await expect(list.getByText("file0.ts", { exact: true })).toBeVisible();
  await expect.poll(() => geometry(list)).toEqual(initial);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("@");
});

test("first-open @ results can grow and flip after asynchronous file search", async ({ workbench: page }) => {
  const { editor, list } = await openTask(page, true);
  for (let i = 0; i < 3; i++) await editor.press("Shift+Enter");
  await editor.press("ArrowUp");
  await editor.press("ArrowUp");
  await editor.press("ArrowUp");
  await editor.pressSequentially("@");
  await expect(list.getByRole("option").first()).toBeVisible();
  await expect.poll(() => geometry(list)).toMatchObject({ side: "below", footerVisible: true });
  await expect(list.getByText("file0.ts", { exact: true })).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event("test:release-composer-files")));
  await expect(list.getByText("file0.ts", { exact: true })).toBeVisible();
  await expect.poll(() => geometry(list)).toMatchObject(fullList);
  await expect(editor).toBeFocused();
});
