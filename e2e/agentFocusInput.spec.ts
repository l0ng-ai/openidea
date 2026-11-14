import type { Locator, Page } from "@playwright/test";
import type { AgentEntry, AgentTask } from "../src/bindings";
import { expect, openFromTree, test } from "./fixtures";

type Placement = "editor" | "toolWindow";

const firstTask: AgentTask = {
  id: "focus-first",
  title: "First focus task",
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
const secondTask: AgentTask = { ...firstTask, id: "focus-second", title: "Second focus task" };
const draft = "draft keep this unsent";
const reboundShortcut = "Control+Meta+Shift+J";
const subagent: AgentEntry = {
  type: "subagent",
  id: "focus-child",
  title: "Inspect focus behavior",
  description: null,
  status: "done",
  error: null,
  prompt: null,
  reply: null,
  tools: 0,
  activity: null,
  startedMs: null,
  endedMs: null,
  cancellable: false,
};

async function seedTasks(page: Page, placement: Placement, status: AgentTask["status"] = "ready") {
  const entries: AgentEntry[] = Array.from({ length: 24 }, (_, turn): AgentEntry[] => [
    { type: "user", text: `Request ${turn}`, attachments: [] },
    { type: "agent", text: `Reply ${turn}` },
  ]).flat();
  await page.evaluate(
    async ({ firstTask, secondTask, entries, subagent, placement, status }) => {
      // These modules must load in the browser's Vite realm, not Playwright's Node process.
      const storePath = "/src/features/agents/store.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const store = await import(storePath);
      const { commands } = await import(ipcPath);
      commands.agentChanges = async () => ({ status: "ok", data: [] });
      document.documentElement.dataset.agentPromptCount = "0";
      commands.agentPrompt = async () => {
        const root = document.documentElement;
        root.dataset.agentPromptCount = String(Number(root.dataset.agentPromptCount) + 1);
        return { status: "ok", data: null };
      };
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([
          [firstTask.id, { ...firstTask, status }],
          [secondTask.id, secondTask],
        ]),
        entries: new Map([
          [firstTask.id, [...entries, subagent]],
          [secondTask.id, entries],
          [`${firstTask.id}/${subagent.id}`, [{ type: "agent", text: "Subagent findings" }]],
        ]),
        composers: new Map(),
        unread: new Set(),
        docked: null,
        homeOpen: false,
        sessionLocation: placement,
      });
      store.openTask(firstTask.id);
    },
    { firstTask, secondTask, entries, subagent, placement, status },
  );
  await expect(messageBox(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

function messageBox(page: Page) {
  return page.getByRole("textbox", { name: "Message", exact: true }).filter({ visible: true });
}

function conversation(page: Page) {
  return page.locator("[class*='_stream_']:visible");
}

// Read the browser selection, not the store's focus request or a registry entry.
async function selection(box: Locator) {
  return box.evaluate((element) => {
    const selected = window.getSelection();
    if (!selected?.anchorNode || !selected.focusNode) return null;
    if (!element.contains(selected.anchorNode) || !element.contains(selected.focusNode)) return null;
    const offset = (node: Node, at: number) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.setEnd(node, at);
      return range.toString().length;
    };
    return {
      anchor: offset(selected.anchorNode, selected.anchorOffset),
      head: offset(selected.focusNode, selected.focusOffset),
      text: selected.toString(),
    };
  });
}

async function selectDraft(box: Locator, range: boolean) {
  await box.fill(draft);
  await box.press("Home");
  for (let index = 0; index < 6; index++) await box.press("ArrowRight");
  if (range) {
    for (let index = 0; index < 4; index++) await box.press("Shift+ArrowRight");
  }
  const expected = { anchor: 6, head: range ? 10 : 6, text: range ? "keep" : "" };
  await expect.poll(() => selection(box)).toEqual(expected);
  return expected;
}

for (const placement of ["editor", "toolWindow"] as const) {
  for (const status of ["ready", "running"] as const) {
    test(`${placement}: default shortcut restores ${status} task input without changing draft, selection or history`, async ({
      workbench: page,
    }) => {
      await seedTasks(page, placement, status);
      const box = messageBox(page);
      const history = conversation(page);
      for (const range of [false, true]) {
        const expected = await selectDraft(box, range);
        await history.click({ position: { x: 12, y: 20 } });
        await expect(history).toBeFocused();
        await history.press("Home");
        await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
        for (let repeat = 0; repeat < 3; repeat++) {
          await page.keyboard.press("Meta+L");
          await expect(box).toBeFocused();
          await expect(box).toHaveText(draft);
          await expect.poll(() => selection(box)).toEqual(expected);
          await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0);
        }
      }
      await expect(page.getByRole("dialog", { name: "Go to Line:Column", exact: true })).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-agent-prompt-count", "0");
    });
  }

  test(`${placement}: focuses the shown task rather than another kept-alive composer`, async ({ workbench: page }) => {
    await seedTasks(page, placement);
    await messageBox(page).fill("first task's unsent draft");
    await page.evaluate(async (id) => {
      // Load the workbench store inside the browser, not the test runner.
      const storePath = "/src/features/agents/store.ts";
      (await import(storePath)).openTask(id);
    }, secondTask.id);
    await messageBox(page).fill("second task's unsent draft");
    if (placement === "editor") {
      await expect(page.getByRole("textbox", { name: "Message", exact: true, includeHidden: true })).toHaveCount(2);
      await page.getByRole("tab", { name: firstTask.title, exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Agent sessions", exact: true }).click();
      await page.getByRole("tree", { name: "Agent tasks" }).getByText(firstTask.title, { exact: true }).dblclick();
    }
    await expect(messageBox(page)).toHaveText("first task's unsent draft");
    await conversation(page).click({ position: { x: 12, y: 20 } });
    await page.keyboard.press("Meta+L");
    await expect(messageBox(page)).toBeFocused();
    await expect(messageBox(page)).toHaveText("first task's unsent draft");
    if (placement === "editor") {
      await page.getByRole("tab", { name: secondTask.title, exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Agent sessions", exact: true }).click();
      await page.getByRole("tree", { name: "Agent tasks" }).getByText(secondTask.title, { exact: true }).dblclick();
    }
    await conversation(page).click({ position: { x: 12, y: 20 } });
    await page.keyboard.press("Meta+L");
    await expect(messageBox(page)).toBeFocused();
    await expect(messageBox(page)).toHaveText("second task's unsent draft");
    await expect(page.locator("html")).toHaveAttribute("data-agent-prompt-count", "0");
  });
}

test("Settings → Keymap rebinds Focus Agent Input and removes its default shortcut", async ({ workbench: page }) => {
  await seedTasks(page, "editor");
  const box = messageBox(page);
  const expected = await selectDraft(box, true);
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("treeitem", { name: "Keymap", exact: true }).click();
  await settings.getByRole("textbox", { name: "Search actions", exact: true }).fill("Focus Agent Input");
  const row = settings.getByRole("tree", { name: "Actions" }).getByRole("treeitem", { name: /Focus Agent Input/ });
  await row.dblclick();
  await page.getByRole("menuitem", { name: "Add Keyboard Shortcut", exact: true }).click();
  const recorder = page.getByRole("dialog", { name: "Keyboard Shortcut: Focus Agent Input", exact: true });
  await recorder.getByRole("textbox", { name: "First stroke" }).press(reboundShortcut);
  await recorder.getByRole("button", { name: "OK", exact: true }).click();
  await expect(recorder).toBeHidden();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove ⌘L", exact: true }).click();
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
  const history = conversation(page);
  await history.click({ position: { x: 12, y: 20 } });
  await expect(history).toBeFocused();
  await page.keyboard.press("Meta+L");
  await expect(history).toBeFocused();
  await expect(box).not.toBeFocused();
  await page.keyboard.press(reboundShortcut);
  await expect(box).toBeFocused();
  await expect(box).toHaveText(draft);
  await expect.poll(() => selection(box)).toEqual(expected);
  await expect(page.locator("html")).toHaveAttribute("data-agent-prompt-count", "0");
});

test("modals and conversation popups keep keyboard focus", async ({ workbench: page }) => {
  await seedTasks(page, "editor");
  const box = messageBox(page);
  await box.fill(draft);
  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings", exact: true });
  await search.fill("keymap");
  await page.keyboard.press("Meta+L");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("keymap");
  await expect(box).not.toBeFocused();
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(settings).toBeHidden();
  const reply = conversation(page).getByText("Reply 0", { exact: true });
  await reply.dblclick();
  await reply.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const firstItem = menu.getByRole("menuitem").first();
  await expect(firstItem).toBeFocused();
  await page.keyboard.press("Meta+L");
  await expect(menu).toBeVisible();
  await expect(firstItem).toBeFocused();
  await expect(box).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toHaveText(draft);
});

test("archived tasks do not focus their disabled composer", async ({ workbench: page }) => {
  await seedTasks(page, "editor", "archived");
  await expect(
    page.getByText("This task is archived. Unarchive it to continue the conversation.", { exact: true }),
  ).toBeVisible();
  const history = conversation(page);
  await history.click({ position: { x: 12, y: 20 } });
  await expect(history).toBeFocused();
  await page.keyboard.press("Meta+L");
  await expect(history).toBeFocused();
  await expect(messageBox(page)).not.toBeFocused();
});

test("subagent conversations do not focus the hidden parent composer", async ({ workbench: page }) => {
  await seedTasks(page, "editor");
  await messageBox(page).fill(draft);
  await page.getByTitle("Open the subagent's conversation", { exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Subagent", exact: true })).toBeVisible();
  const history = conversation(page);
  await history.click({ position: { x: 12, y: 20 } });
  await expect(history).toBeFocused();
  await page.keyboard.press("Meta+L");
  await expect(history).toBeFocused();
  await expect(messageBox(page)).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Subagent", exact: true })
    .getByRole("button", { name: firstTask.title, exact: true })
    .click();
  await expect(messageBox(page)).toHaveText(draft);
  await conversation(page).click({ position: { x: 12, y: 20 } });
  await page.keyboard.press("Meta+L");
  await expect(messageBox(page)).toBeFocused();
});

test("editor Go to Line stays available while a docked agent conversation is visible", async ({ workbench: page }) => {
  const editor = await openFromTree(page, "README.md");
  await seedTasks(page, "toolWindow");
  await messageBox(page).fill(draft);
  const content = editor.locator(".cm-content");
  await content.click();
  await page.keyboard.press("Meta+L");
  const dialog = page.getByRole("dialog", { name: "Go to Line:Column", exact: true });
  const line = dialog.getByRole("textbox", { name: "Line and column", exact: true });
  await expect(line).toBeFocused();
  await expect(messageBox(page)).not.toBeFocused();
  await line.fill("2:1");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(content).toBeFocused();
  await expect(messageBox(page)).toHaveText(draft);
});

for (const preset of ["intellij-windows", "vscode-windows", "eclipse-windows"]) {
  test(`${preset} uses Ctrl+L to focus the task message`, async ({ workbench: page }) => {
    await seedTasks(page, "editor");
    const box = messageBox(page);
    const expected = await selectDraft(box, true);
    await page.evaluate(async (preset) => {
      // Load the keymap in the browser where keyboard dispatch runs.
      const keymapPath = "/src/platform/keymap.ts";
      (await import(keymapPath)).applyKeymapSettings(preset, {});
    }, preset);
    const history = conversation(page);
    await history.click({ position: { x: 12, y: 20 } });
    await expect(history).toBeFocused();
    await page.keyboard.press("Control+L");
    await expect(box).toBeFocused();
    await expect(box).toHaveText(draft);
    await expect.poll(() => selection(box)).toEqual(expected);
    await expect(page.locator("html")).toHaveAttribute("data-agent-prompt-count", "0");
  });
}

test("Find Action focuses the current task input after closing its popup", async ({ workbench: page }) => {
  await seedTasks(page, "editor");
  const box = messageBox(page);
  const expected = await selectDraft(box, true);
  await conversation(page).click({ position: { x: 12, y: 20 } });
  await page.keyboard.press("Meta+Shift+A");
  const search = page.getByRole("dialog", { name: "Search Everywhere", exact: true });
  const query = search.getByRole("combobox");
  await query.fill("Focus Agent Input");
  await expect(search.getByRole("option", { name: /Focus Agent Input/ })).toBeVisible();
  await query.press("Enter");
  await expect(search).toBeHidden();
  await expect(box).toBeFocused();
  await expect(box).toHaveText(draft);
  await expect.poll(() => selection(box)).toEqual(expected);
});

test("docked Changes view returns to the task input without losing its selection", async ({ workbench: page }) => {
  await seedTasks(page, "toolWindow");
  const box = messageBox(page);
  const expected = await selectDraft(box, true);
  await page.evaluate(async (id) => {
    // Seed the store in the browser realm; a static import would run in Node.
    const storePath = "/src/features/agents/store.ts";
    (await import(storePath)).useAgents.setState({
      changes: new Map([
        [
          id,
          [
            {
              path: "/dev/acme-api/file.ts",
              relPath: "file.ts",
              kind: "modified",
              added: 1,
              removed: 0,
              oldPath: null,
            },
          ],
        ],
      ]),
    });
  }, firstTask.id);
  await page.getByRole("button", { name: /1 changed file/ }).click();
  const changes = page.getByRole("complementary", { name: "Changes", exact: true });
  await expect(changes).toBeVisible();
  await expect(box).toHaveCount(0);
  await changes.getByRole("button", { name: "Back to conversation", exact: true }).focus();
  await page.keyboard.press("Meta+L");
  await expect(changes).toBeHidden();
  await expect(box).toBeFocused();
  await expect(box).toHaveText(draft);
  await expect.poll(() => selection(box)).toEqual(expected);
});
