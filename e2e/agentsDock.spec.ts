/** Docking agent conversations between the main editor and a separate conversation pane by drag & drop. */
import { expect, test, type Page } from "@playwright/test";

const TASK = {
  id: "t1",
  title: "Repro task",
  status: "ready" as const,
  isolation: "local" as const,
  provider: "codex",
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

/** Seeds one task in the agents store (no backend in plain-browser mode) and docks it. */
async function seedAndDock(page: Page) {
  await page.evaluate(async (task) => {
    // Paths go through variables: knip can't resolve these browser-absolute URLs.
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    store.useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map([[task.id, task]]),
      unread: new Set(),
      docked: null,
    });
    store.setSessionLocation("pane", task.id);
  }, TASK);
  await page.getByRole("region", { name: "Agent Chat", exact: true }).waitFor();
}

test("drags the docked conversation back onto the editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  // An editor pane, so the session tab has a content drop target to land on.
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await page.getByRole("tab", { name: "README.md" }).waitFor();
  await seedAndDock(page);

  const title = page.getByRole("region", { name: "Agent Chat", exact: true }).locator("span[title='Repro task']");
  const to = await page.getByRole("tabpanel").first().boundingBox();
  const from = await title.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByRole("tabpanel", { name: "Repro task", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Repro task" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent Chat", exact: true })).toBeHidden();
});

test("drags the docked conversation back onto the empty editor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  // Docking closes the session tab; with no other tabs the editor is empty and
  // must still take the drop (regression: the empty state had no drop target).
  await seedAndDock(page);
  await expect(page.locator("[data-editor-area] [role='tabpanel']")).toHaveCount(0);

  const title = page.getByRole("region", { name: "Agent Chat", exact: true }).locator("span[title='Repro task']");
  const to = await page.getByText("Drop files here to open them").boundingBox();
  const from = await title.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect(page.getByRole("tabpanel", { name: "Repro task", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Repro task" })).toHaveCount(0);
});

for (const [side, label] of [
  ["left", "Left"],
  ["right", "Right"],
  ["top", "Top"],
  ["bottom", "Bottom"],
] as const) {
  test(`opens chat on the ${side} and returns it to the main area without losing a draft`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tree", { name: "Project" }).waitFor();
    await page.locator("#splash").waitFor({ state: "detached" });
    await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await seedAndDock(page);
    const agents = () => page.locator('[data-toolwindow="agents"]');
    const chat = page.getByRole("region", { name: "Agent Chat", exact: true });
    const before = await agents().boundingBox();
    const layout = await page.evaluate(async () => {
      const path = "/src/workbench/toolwindows/store.ts";
      const { placements, sizes, visible, viewModes, splits, windowSizes } = (
        await import(path)
      ).useToolWindowLayout.getState();
      return JSON.stringify({ placements, sizes, visible, viewModes, splits, windowSizes });
    });
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this conversation draft");
    const choose = async (name: string) => {
      await agents().getByRole("button", { name: "Options", exact: true }).click();
      await page.getByRole("menuitem", { name: "Open Chat In", exact: true }).hover();
      await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
    };
    await choose(label);
    await expect(page.locator(`[data-editor-area] [data-chat-side="${side}"]`)).toBeVisible();
    expect(await agents().boundingBox()).toEqual(before);
    expect(
      await page.evaluate(async () => {
        const path = "/src/workbench/toolwindows/store.ts";
        const { placements, sizes, visible, viewModes, splits, windowSizes } = (
          await import(path)
        ).useToolWindowLayout.getState();
        return JSON.stringify({ placements, sizes, visible, viewModes, splits, windowSizes });
      }),
    ).toBe(layout);
    await expect(page.getByRole("tree", { name: "Agent tasks" })).toBeVisible();
    await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveText(
      "Keep this conversation draft",
    );
    await choose("Main Area");
    const conversation = page.getByRole("tabpanel", { name: TASK.title, exact: true });
    await expect(conversation).toBeVisible();
    await expect(conversation.getByRole("textbox", { name: "Message", exact: true })).toHaveText(
      "Keep this conversation draft",
    );
    await expect(page.getByRole("tab", { name: TASK.title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
    await expect(page.getByRole("tree", { name: "Agent tasks" })).toBeVisible();
  });
}
