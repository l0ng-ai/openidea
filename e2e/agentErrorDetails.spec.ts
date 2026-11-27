import type { Page } from "@playwright/test";
import type { AgentEntry, AgentTask } from "../src/bindings";
import { expect, openFromTree, test } from "./fixtures";

const policyMessage = "This content was flagged for possible cybersecurity risk.";
const policyDetails = "Contact support if this is unexpected.";
const diagnostics = `${policyMessage}\n${policyDetails}\nCodex error: cyberPolicy`;
const now = Date.now();
const task: AgentTask = {
  id: "sample-policy-failure",
  title: "Investigate sample editor crash",
  provider: "codex",
  model: null,
  status: "failed",
  isolation: "local",
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: diagnostics,
  createdMs: now - 2000,
  updatedMs: now,
  config: [],
  commands: [],
  usage: null,
  queue: [],
};
const entries: AgentEntry[] = [
  {
    type: "user",
    text: "Investigate and fix the sample editor shutdown crash.",
    attachments: [],
    sentMs: now - 2000,
    doneMs: now - 1000,
  },
  { type: "agent", text: "I will check the shutdown sequence and run the regression tests." },
  { type: "error", message: diagnostics },
];

async function showFailure(page: Page) {
  await page.evaluate(
    async ({ task, entries }) => {
      const storePath = "/src/features/agents/store.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const store = await import(storePath);
      const { commands } = await import(ipcPath);
      commands.agentEntries = async () => ({ status: "ok", data: entries });
      commands.agentChanges = async () => ({ status: "ok", data: [] });
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([[task.id, task]]),
        entries: new Map(),
        unread: new Set(),
      });
      await store.openTaskInEditorLocation(task.id);
    },
    { task, entries },
  );
}

for (const width of [1400, 700]) {
  test(`preserves saved Codex error details and code at width ${width}`, async ({ workbench: page }) => {
    await page.setViewportSize({ width, height: 900 });
    await showFailure(page);
    const error = page.getByRole("alert").filter({ hasText: policyMessage });
    await expect(error).toBeVisible();
    await expect(error).toContainText(policyDetails);
    await expect(error).toContainText("Codex error: cyberPolicy");
    await expect(error).toHaveCSS("white-space", "pre-wrap");
    await expect(page.getByText("The agent declined to continue.", { exact: true })).toHaveCount(0);
    await expect(error.getByRole("button", { name: "Sign In…" })).toHaveCount(0);
    expect(await error.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    // A different editor must not replace the saved failure with a generic task status.
    await openFromTree(page, "README.md");
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("tree", { name: "Agent tasks", exact: true }).getByText(task.title, { exact: true }).click();
    await expect(error).toContainText(diagnostics);
  });
}
