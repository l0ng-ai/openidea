import type { AgentEntry, AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const first: AgentTask = {
  id: "context-first",
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
const second: AgentTask = { ...first, id: "context-second", title: "Second conversation" };

for (const active of ["conversation", "file"] as const) {
  test(`an agent context menu keeps the current ${active} open`, async ({ workbench: page }) => {
    await page.getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
    await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
    await page.evaluate(
      async ({ first, second }) => {
        const storePath = "/src/features/agents/store.ts";
        const ipcPath = "/src/platform/ipc.ts";
        const contributionsPath = "/src/workbench/contributions.ts";
        const store = await import(storePath);
        const { commands } = await import(ipcPath);
        const { toolWindowService } = await import(contributionsPath);
        commands.agentChanges = async () => ({ status: "ok", data: [] });
        const entries: AgentEntry[] = [{ type: "agent", text: "The active conversation stays here." }];
        store.useAgents.setState({
          loaded: true,
          error: null,
          providers: [],
          tasks: new Map([
            [first.id, first],
            [second.id, second],
          ]),
          entries: new Map([
            [first.id, entries],
            [second.id, []],
          ]),
          composers: new Map([[first.id, { text: "Keep this unsent draft", files: [], images: [] }]]),
          unread: new Set(),
          docked: null,
          homeOpen: false,
          sessionLocation: "editor",
        });
        toolWindowService().show("agents", true);
        store.openTask(first.id);
      },
      { first, second },
    );
    const firstTab = page.getByRole("tab", { name: first.title, exact: true });
    const fileTab = page.getByRole("tab", { name: "README.md", exact: true });
    await expect(firstTab).toHaveAttribute("aria-selected", "true");
    if (active === "file") await fileTab.click();
    const current = active === "file" ? fileTab : firstTab;
    const target = page.getByRole("tree", { name: "Agent tasks" }).getByText(second.title, { exact: true });
    await target.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Rename…", exact: true })).toBeVisible();
    await expect(current).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: second.title, exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(current).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const storePath = "/src/features/agents/store.ts";
          return (await import(storePath)).composerDraft(id).text;
        }, first.id),
      )
      .toBe("Keep this unsent draft");
    await target.click();
    await expect(page.getByRole("tab", { name: second.title, exact: true })).toHaveAttribute("aria-selected", "true");
  });
}
