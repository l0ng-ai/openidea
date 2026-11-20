import type { AgentTask } from "../src/bindings";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const first: AgentTask = {
  id: "placement-one",
  title: "First conversation",
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
const second = { ...first, id: "placement-two", title: "Second conversation" };
async function seed(page: Page) {
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await page.evaluate(
    async ({ first, second }) => {
      const path = "/src/features/agents/store.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const store = await import(path);
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([
          [first.id, first],
          [second.id, second],
        ]),
        entries: new Map([
          [first.id, [{ type: "agent", text: "First conversation content" }]],
          [second.id, [{ type: "agent", text: "Second conversation content" }]],
        ]),
        composers: new Map([[first.id, { text: "Unsent first draft", files: [], images: [] }]]),
        unread: new Set(),
        docked: null,
        homeOpen: false,
        sessionLocation: "editor",
      });
      (await import(contributionsPath)).toolWindowService().show("agents", true);
      store.openTask(first.id);
    },
    { first, second },
  );
  await expect(page.getByRole("tabpanel", { name: first.title, exact: true })).toBeVisible();
}

test("manages conversations in Agents while the tab strip and Switcher contain only files", async ({
  workbench: page,
}) => {
  await seed(page);
  await expect(page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab")).toHaveCount(1);
  const tasks = page.getByRole("tree", { name: "Agent tasks" });
  await tasks.getByText(second.title, { exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: second.title, exact: true })).toBeVisible();
  await tasks.getByText(first.title, { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Unsent first draft");
  await page.getByRole("tabpanel", { name: first.title, exact: true }).click({ position: { x: 10, y: 20 } });
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  const switcher = page.getByRole("dialog", { name: "Switcher", exact: true });
  await expect(switcher).toBeVisible();
  await expect(switcher.getByText(first.title, { exact: true })).toHaveCount(0);
  await expect(switcher.getByText(second.title, { exact: true })).toHaveCount(0);
  await expect(switcher.getByText("README.md", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.up("Control");
});

test("keeps a conversation when Close All Tabs closes the file tabs", async ({ workbench: page }) => {
  await seed(page);
  await page.getByRole("tab", { name: "README.md", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close All Tabs", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Editor tabs" })).toHaveCount(0);
  await expect(page.getByRole("tabpanel", { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Unsent first draft");
});

test("reorders file tabs correctly with a conversation between their internal editor positions", async ({
  workbench: page,
}) => {
  await seed(page);
  await page.getByRole("treeitem", { name: "App.tsx", exact: true }).dblclick();
  await page.getByRole("treeitem", { name: "build.gradle.kts", exact: true }).dblclick();
  const moving = await page.getByRole("tab", { name: "App.tsx", exact: true }).boundingBox();
  const before = await page.getByRole("tab", { name: "README.md", exact: true }).boundingBox();
  await page.mouse.move(moving!.x + moving!.width / 2, moving!.y + moving!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + 4, before!.y + before!.height / 2, { steps: 14 });
  await page.mouse.up();
  await expect(page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab")).toHaveText([
    "App.tsx",
    "README.md",
    "build.gradle.kts",
  ]);
  await page.getByRole("tree", { name: "Agent tasks" }).getByText(first.title, { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Unsent first draft");
});

test("the shared placement menu targets the right-clicked task when opening a new window", async ({
  workbench: page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const path = "/src/platform/actions.ts";
    (await import(path)).registerAction({
      id: "agents.moveToNewWindow",
      title: "Open in New Window",
      run: ({ arg }: { arg: unknown }) => {
        document.documentElement.dataset.requestedConversationWindow = String(arg);
      },
    });
  });
  await page
    .getByRole("tree", { name: "Agent tasks" })
    .getByText(second.title, { exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open Chat In", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New Window", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-requested-conversation-window", second.id);
  await expect(page.getByRole("tabpanel", { name: first.title, exact: true })).toBeVisible();
});

test("keeps Agents independent while moving, resizing and hiding the conversation body", async ({
  workbench: page,
}) => {
  await seed(page);
  const agents = page.locator('[data-toolwindow="agents"]');
  const choose = async (name: string) => {
    const chat = page.getByRole("region", { name: "Agent Chat", exact: true });
    const button = (await chat.isVisible())
      ? chat.getByRole("button", { name: "Conversation options", exact: true })
      : agents.getByRole("button", { name: "Options", exact: true });
    await button.click();
    await page.getByRole("menuitem", { name: "Open Chat In", exact: true }).hover();
    await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  };
  const layout = () =>
    page.evaluate(async () => {
      const path = "/src/workbench/toolwindows/store.ts";
      const { placements, visible, sizes, splits, viewModes, windowSizes } = (
        await import(path)
      ).useToolWindowLayout.getState();
      return JSON.stringify({ placements, visible, sizes, splits, viewModes, windowSizes });
    });
  const original = await layout();
  const bounds = await agents.boundingBox();
  await choose("Right");
  const chat = page.getByRole("region", { name: "Agent Chat", exact: true });
  const file = page.getByRole("tabpanel", { name: "README.md", exact: true });
  await file.evaluate((element) => {
    element.dataset.placementSentinel = "retained";
  });
  const composer = chat.getByRole("textbox", { name: "Message", exact: true });
  await composer.evaluate((element) => {
    element.dataset.placementSentinel = "retained";
  });
  for (const [side, name] of [
    ["left", "Left"],
    ["top", "Top"],
    ["bottom", "Bottom"],
    ["right", "Right"],
  ] as const) {
    await choose(name);
    await expect(page.locator(`[data-editor-area] [data-chat-side="${side}"]`)).toBeVisible();
    await expect(page.getByRole("tree", { name: "Agent tasks" })).toBeVisible();
    await expect(composer).toHaveText("Unsent first draft");
    await expect(composer).toHaveAttribute("data-placement-sentinel", "retained");
    await expect(file).toHaveAttribute("data-placement-sentinel", "retained");
    expect(await agents.boundingBox()).toEqual(bounds);
    expect(await layout()).toBe(original);
    const chatBounds = (await chat.boundingBox())!;
    const fileBounds = (await file.boundingBox())!;
    if (side === "left") expect(chatBounds.x + chatBounds.width).toBeLessThanOrEqual(fileBounds.x);
    if (side === "right") expect(fileBounds.x + fileBounds.width).toBeLessThanOrEqual(chatBounds.x);
    if (side === "top") expect(chatBounds.y + chatBounds.height).toBeLessThanOrEqual(fileBounds.y);
    if (side === "bottom") expect(fileBounds.y + fileBounds.height).toBeLessThanOrEqual(chatBounds.y);
  }
  const width = (await chat.boundingBox())!.width;
  await page.getByRole("separator", { name: "Resize conversation pane" }).press("ArrowLeft");
  expect((await chat.boundingBox())!.width).toBeGreaterThan(width);
  expect(await layout()).toBe(original);
  await agents.getByRole("button", { name: "Hide", exact: true }).click();
  const hiddenLayout = await layout();
  await choose("Bottom");
  await expect(agents).toBeHidden();
  expect(await layout()).toBe(hiddenLayout);
  await expect(composer).toHaveText("Unsent first draft");
  await chat.getByRole("button", { name: "Hide Conversation", exact: true }).click();
  await expect(chat).toBeHidden();
  await expect(file).toBeVisible();
  expect(await layout()).toBe(hiddenLayout);
});

test("opens conversations in Agents and retains its history picker and drafts", async ({ workbench: page }) => {
  await seed(page);
  const agents = page.locator('[data-toolwindow="agents"]');
  const before = await agents.boundingBox();
  const choose = async (name: string) => {
    await agents.getByRole("button", { name: "Options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open Chat In", exact: true }).hover();
    await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  };
  await choose("Agents");
  const composer = agents.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toHaveText("Unsent first draft");
  await expect(page.getByRole("region", { name: "Agent Chat", exact: true })).toBeHidden();
  expect(await agents.boundingBox()).toEqual(before);
  await agents.getByRole("button", { name: "Agent sessions", exact: true }).click();
  await page.getByRole("tree", { name: "Agent tasks" }).getByText(second.title, { exact: true }).click();
  await expect(agents.getByText("Second conversation content", { exact: true })).toBeVisible();
  await composer.fill("Unsent second draft");
  await agents.getByRole("button", { name: "Agent sessions", exact: true }).click();
  await page.getByRole("tree", { name: "Agent tasks" }).getByText(first.title, { exact: true }).click();
  await expect(composer).toHaveText("Unsent first draft");
  await choose("Top");
  await expect(page.locator('[data-editor-area] [data-chat-side="top"]')).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Agent Chat", exact: true })
      .getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("Unsent first draft");
  await expect(page.getByRole("tree", { name: "Agent tasks" })).toBeVisible();
  expect(await agents.boundingBox()).toEqual(before);
  await choose("Main Area");
  await expect(page.getByRole("tabpanel", { name: first.title, exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Unsent first draft");
});
