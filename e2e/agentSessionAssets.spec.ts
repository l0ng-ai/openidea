/** Session Pull Requests, Issues, References, and Artifacts surfaced above the agent composer. */
import type { AgentEntry, AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const TASK: AgentTask = {
  id: "session-assets-task",
  title: "Storage session pooling",
  provider: "copilot",
  model: "claude-sonnet-4",
  status: "ready",
  isolation: "local",
  cwd: "/dev/acme-api",
  projectRoot: "/dev/acme-api",
  branch: "feat/session-pooling",
  base: "main",
  baseCommit: null,
  error: null,
  createdMs: 1_763_250_000_000,
  updatedMs: 1_763_250_120_000,
  config: [],
  commands: [],
  usage: null,
  queue: [],
};

const ENTRIES: AgentEntry[] = [
  {
    type: "user",
    text: "Investigate [Issue #418: Connection pool contention under burst traffic](https://github.com/acme/acme-api/issues/418) and draft a migration report.",
    attachments: [],
    sentMs: 1_763_250_010_000,
    doneMs: 1_763_250_090_000,
    steered: false,
  },
  {
    type: "tool",
    id: "tool-issue",
    title: 'gh issue create -R acme/acme-api --title "Track session lease renewal metrics"',
    kind: "execute",
    status: "completed",
    locations: [],
    output: "https://github.com/acme/acme-api/issues/512\n",
    diffs: [],
  },
  {
    type: "tool",
    id: "tool-doc",
    title: "Write architecture-overview.md",
    kind: "edit",
    status: "completed",
    locations: ["/dev/acme-api/docs/architecture-overview.md"],
    output: null,
    diffs: [{ path: "/dev/acme-api/docs/architecture-overview.md", added: 64, removed: 0 }],
  },
  {
    type: "agent",
    text: [
      "Opened PRs and wrote the architecture summary:",
      "- [#510 feat(pool): add bounded session lease cache](https://github.com/acme/acme-api/pull/510)",
      "- [#511 chore(metrics): export pool saturation histogram](https://github.com/acme/acme-api/pull/511)",
      "- Context commit [a4f91c2](https://github.com/acme/acme-api/commit/a4f91c2890123456) and [Discussion #309: Async pool sizing](https://github.com/acme/acme-api/discussions/309)",
      "- Live telemetry: [Datadog Dashboard: Pool Latency (abc-def-123)](https://app.datadoghq.com/dashboard/abc-def-123)",
      "- Referenced `specs/api-spec.pdf` and `docs/migration-plan.docx`.",
    ].join("\n"),
  },
];

test("surfaces session pull requests, issues, references, and artifacts above the composer", async ({
  workbench: page,
}) => {
  await page.evaluate(
    async ({ task, entries }) => {
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
        entries: new Map([[task.id, entries]]),
        composers: new Map(),
        unread: new Set(),
        docked: null,
        sessionLocation: "editor",
      });
      store.openTask(task.id);
    },
    { task: TASK, entries: ENTRIES },
  );

  const bar = page.getByRole("toolbar", { name: "Session references and artifacts" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "2 Pull Requests" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "1 Issue" })).toHaveText("#512");
  await expect(bar.getByRole("button", { name: "3 References" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "4 Artifacts" })).toBeVisible();

  // Open Artifacts popup, insert a Markdown artifact mention into the CodeMirror composer, then dismiss one item.
  await bar.getByRole("button", { name: "4 Artifacts" }).click();
  const dialog = page.getByRole("dialog", { name: "Artifacts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Websites")).toBeVisible();
  await expect(dialog.getByText("Files")).toBeVisible();

  const mdRow = dialog.getByRole("button", { name: "architecture-overview.md" }).locator("..");
  await mdRow.hover();
  await mdRow.getByRole("button", { name: "Add to Message" }).click();
  await expect(dialog).toHaveCount(0);

  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(box).toContainText("architecture-overview.md");
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const storePath = "/src/features/agents/store.ts";
        return (await import(storePath)).composerDraft(id).text;
      }, TASK.id),
    )
    .toBe("@docs/architecture-overview.md ");

  await bar.getByRole("button", { name: "4 Artifacts" }).click();
  const dialogAfter = page.getByRole("dialog", { name: "Artifacts" });
  const webRow = dialogAfter.getByRole("button", { name: /Datadog Dashboard: Pool Latency/ }).locator("..");
  await webRow.hover();
  await webRow.getByRole("button", { name: "Remove" }).click();
  await expect(bar.getByRole("button", { name: "3 Artifacts" })).toBeVisible();
});
