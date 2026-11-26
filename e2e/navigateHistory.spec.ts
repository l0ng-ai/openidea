/** Navigate Back / Forward (⌘[ / ⌘], ⌥⌘← / ⌥⌘→) across text files, non-file editor tabs, and split panes. */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const AGENT_TASKS = [
  {
    id: "task-k8s",
    title: "Inspect rollout logs",
    status: "ready" as const,
    isolation: "local" as const,
    provider: "codex",
    model: null,
    cwd: "/dev/acme-api",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 1,
    updatedMs: 2,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  },
  {
    id: "task-api",
    title: "Refactor health check",
    status: "ready" as const,
    isolation: "local" as const,
    provider: "claude",
    model: null,
    cwd: "/dev/acme-api",
    branch: null,
    base: null,
    baseCommit: null,
    error: null,
    createdMs: 1,
    updatedMs: 1,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  },
];

async function seedAgents(page: Page) {
  await page.evaluate(async (tasks) => {
    const agentsStorePath = "/src/features/agents/store.ts";
    const { useAgents } = await import(/* @vite-ignore */ agentsStorePath);
    useAgents.setState({
      loaded: true,
      error: null,
      providers: [],
      tasks: new Map(tasks.map((t) => [t.id, t])),
      entries: new Map([
        [
          "task-k8s",
          [
            { type: "user", text: "Check why acme-api pod restarted in prod-us-west", attachments: [] },
            {
              type: "agent",
              text: "Checked `acme-api-7f9b4` rollout events: liveness probe timed out during migration warm-up.",
            },
          ],
        ],
        [
          "task-api",
          [
            { type: "user", text: "Simplify /healthz handler in App.tsx", attachments: [] },
            { type: "agent", text: "Ready to split liveness and readiness checks." },
          ],
        ],
      ]),
      unread: new Set(),
      docked: null,
      homeOpen: false,
      sessionLocation: "editor",
    });
  }, AGENT_TASKS);
}

async function activeEditorState(page: Page) {
  return page.evaluate(async () => {
    const ctrlPath = "/src/editor/core/controller.ts";
    const twPath = "/src/workbench/toolwindows/store.ts";
    const { editorController, useTabs } = await import(/* @vite-ignore */ ctrlPath);
    const { useToolWindowLayout } = await import(/* @vite-ignore */ twPath);
    return {
      key: editorController().activeInput()?.key ?? null,
      pane: useTabs.getState().activePane,
      toolWindow: useToolWindowLayout.getState().focused,
    };
  });
}

test("navigates back and forward across text files, agent chat tabs, and terminal editor tabs, skipping closed terminal tabs", async ({
  workbench: page,
}) => {
  await seedAgents(page);

  // 1. Open App.tsx.
  await page.getByRole("treeitem", { name: "App.tsx", exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: "App.tsx" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Editor for /dev/acme-api/App.tsx" })).toBeFocused();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/App.tsx" });

  // 2. Open an Agent chat tab (no file path).
  await page.evaluate(async () => {
    const agentsStorePath = "/src/features/agents/store.ts";
    const { openTask } = await import(/* @vite-ignore */ agentsStorePath);
    openTask("task-k8s");
  });
  await expect(page.getByRole("tab", { name: "Inspect rollout logs" })).toBeVisible();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-k8s" });

  // 3. Open a Terminal editor tab (no file path).
  await page.evaluate(async () => {
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("terminal.newInEditor");
  });
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: expect.stringMatching(/^cli:/) });
  const cliKey = (await activeEditorState(page)).key!;

  // 4. Open README.md.
  await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Editor for /dev/acme-api/README.md" })).toBeFocused();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/README.md" });

  // 5. Move focus to Project tool window, then press ⌘[ — IDEA behavior: goes to the previous editor place (CLI tab), not a tool window.
  await page.getByRole("tree", { name: "Project" }).focus();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ toolWindow: "project" });

  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: cliKey, toolWindow: null });

  // 6. Walk Back from Terminal editor tab → Agent chat tab → App.tsx.
  await page.keyboard.press("Meta+Alt+ArrowLeft");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-k8s" });

  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/App.tsx" });

  // 7. Walk Forward all the way back to README.md.
  await page.keyboard.press("Meta+]");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-k8s" });

  await page.keyboard.press("Meta+Alt+ArrowRight");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: cliKey });

  await page.keyboard.press("Meta+]");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/README.md" });

  // 8. Close the ephemeral CLI terminal tab: Back from README.md skips it and lands directly on the Agent chat tab.
  await page.evaluate(async (key) => {
    const ctrlPath = "/src/editor/core/controller.ts";
    const { editorController } = await import(/* @vite-ignore */ ctrlPath);
    await editorController().closeInput(key);
  }, cliKey);
  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-k8s" });
});

test("tracks split panes across same-file splits, non-text split tabs, and moved tabs", async ({ workbench: page }) => {
  await seedAgents(page);

  // Open App.tsx in left pane and split it right (same file in both panes).
  await page.getByRole("treeitem", { name: "App.tsx", exact: true }).dblclick();
  await expect(page.locator("[data-editor-area] .cm-content").first()).toBeFocused();
  const leftPane = (await activeEditorState(page)).pane;

  await page.evaluate(async () => {
    const ctrlPath = "/src/editor/core/controller.ts";
    const { editorController, useTabs } = await import(/* @vite-ignore */ ctrlPath);
    editorController().split(useTabs.getState().activePane, "row");
  });
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  const rightPane = (await activeEditorState(page)).pane;
  expect(rightPane).not.toBe(leftPane);
  await expect(page.locator(`[data-pane-id="${rightPane}"] .cm-content`)).toBeFocused();

  // Open an Agent chat tab in the right split pane.
  await page.evaluate(async () => {
    const ctrlPath = "/src/editor/core/controller.ts";
    const { editorController } = await import(/* @vite-ignore */ ctrlPath);
    await editorController().openInput(
      { kind: "agent-session", key: "agent:task-api", data: { task: "task-api", title: "Refactor health check" } },
      { focus: true },
    );
  });
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-api", pane: rightPane });

  // Click into the left split pane's editor, then click back into the right split pane's Agent chat composer.
  await page.locator(`[data-pane-id="${leftPane}"] .cm-content`).click();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/App.tsx", pane: leftPane });

  await page.locator(`[data-pane-id="${rightPane}"]`).getByRole("textbox", { name: "Message" }).click();
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-api", pane: rightPane });

  // Walk Back through the split-pane history: Agent Chat (right) → App.tsx (left) → Agent Chat (right) → App.tsx (right) → App.tsx (left).
  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/App.tsx", pane: leftPane });

  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-api", pane: rightPane });

  await page.keyboard.press("Meta+[");
  await expect
    .poll(() => activeEditorState(page))
    .toMatchObject({ key: "file:/dev/acme-api/App.tsx", pane: rightPane });

  await page.keyboard.press("Meta+[");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "file:/dev/acme-api/App.tsx", pane: leftPane });

  // Forward returns across the splits in exact order.
  await page.keyboard.press("Meta+]");
  await expect
    .poll(() => activeEditorState(page))
    .toMatchObject({ key: "file:/dev/acme-api/App.tsx", pane: rightPane });

  await page.keyboard.press("Meta+]");
  await expect.poll(() => activeEditorState(page)).toMatchObject({ key: "agent:task-api", pane: rightPane });
});
