import { expect, test } from "@playwright/test";
import type { AgentEntry, AgentTask } from "../src/bindings";

const task: AgentTask = {
  id: "approval",
  title: "Command approval",
  status: "needsInput",
  isolation: "local",
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
const command = `python3 -c 'import pathlib\np = pathlib.Path("note.txt")\np.write_text("${"long content ".repeat(80)}")'`;
const entries: AgentEntry[] = [
  { type: "user", text: "Write a note with Python.", attachments: [], steered: false },
  { type: "thought", text: "I need approval to write." },
  {
    type: "tool",
    id: "inspect",
    title: "Read README.md",
    kind: "read",
    status: "completed",
    locations: [],
    output: null,
    diffs: [],
  },
  { type: "agent", text: "I will request approval before writing the note." },
  {
    type: "tool",
    id: "read",
    title: "List .",
    kind: "search",
    status: "running",
    locations: [],
    output: null,
    diffs: [],
  },
  {
    type: "permission",
    id: 1,
    title: `Run ${command}`,
    command,
    options: [
      { id: "once", kind: "allow_once", name: "Allow once" },
      { id: "always", kind: "allow_always", name: `Always allow \`${command}\`` },
      { id: "decline", kind: "reject_once", name: "Decline" },
      { id: "cancel", kind: "reject_once", name: "Decline and stop" },
    ],
    chosen: null,
  },
];

for (const choice of ["codex-trust-project", "codex-keep-untrusted"]) {
  test(`project trust has explicit choices and submits ${choice}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1050, height: 800 });
    await page.goto("/");
    await page.getByRole("tree", { name: "Project" }).waitFor();
    await page.evaluate(
      async ({ task }) => {
        const path = "/src/features/agents/store.ts";
        const store = await import(path);
        store.useAgents.setState({
          loaded: true,
          tasks: new Map([[task.id, task]]),
          entries: new Map([
            [
              task.id,
              [
                { type: "user", text: "Load the project's MCP configuration.", attachments: [], steered: false },
                { type: "error", message: "Project-local config is disabled until the project is trusted in Codex." },
                {
                  type: "permission",
                  id: 2,
                  title:
                    "Trust project in Codex: /dev/acme-api? This saves trust in your Codex user configuration and allows this project's MCP servers, hooks and exec policies to load.",
                  command: null,
                  options: [
                    { id: "codex-trust-project", name: "Trust Project in Codex", kind: "allow_always" },
                    { id: "codex-keep-untrusted", name: "Keep Untrusted", kind: "reject_once" },
                  ],
                  chosen: null,
                },
              ],
            ],
          ]),
        });
        store.openTaskInEditorLocation(task.id);
        const ipcPath = "/src/platform/ipc.ts";
        (await import(ipcPath)).commands.agentRespond = async (task: string, permission: number, option: string) => {
          (window as unknown as { trustAnswer: unknown }).trustAnswer = { task, permission, option };
          return { status: "ok", data: null };
        };
      },
      { task },
    );
    const card = page.getByRole("region", { name: "Trust Project in Codex" });
    await expect(card).toBeVisible();
    await expect(
      page.getByText("Project-local config is disabled until the project is trusted in Codex."),
    ).toBeVisible();
    await expect(card.getByRole("button")).toHaveText(["Trust Project in Codex", "Keep Untrusted"]);
    await expect(card).toContainText("MCP servers, hooks and exec policies");
    expect(await page.evaluate(() => (window as unknown as { trustAnswer?: unknown }).trustAnswer)).toBeUndefined();
    await page.screenshot({ path: testInfo.outputPath("project-trust-confirmation.png"), animations: "disabled" });
    await card
      .getByRole("button", {
        name: choice === "codex-trust-project" ? "Trust Project in Codex" : "Keep Untrusted",
        exact: true,
      })
      .click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { trustAnswer?: unknown }).trustAnswer))
      .toEqual({ task: task.id, permission: 2, option: choice });
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [760, 1400]) {
    test(`approval is asked above the composer at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.getByRole("tree", { name: "Project" }).waitFor();
      await page.evaluate(
        async ({ task, entries, theme }) => {
          const path = "/src/features/agents/store.ts";
          const store = await import(path);
          const themePath = "/src/workbench/theme.ts";
          (await import(themePath)).previewTheme(theme);
          store.useAgents.setState({
            loaded: true,
            tasks: new Map([[task.id, task]]),
            entries: new Map([[task.id, entries]]),
          });
          store.openTaskInEditorLocation(task.id);
        },
        { task, entries, theme },
      );
      const card = page.getByRole("region", { name: "codex wants to run a command" });
      await expect(card).toHaveCount(1);
      await expect(card.locator("pre")).toHaveText(command);
      await expect(card.getByRole("button")).toHaveText(["Allow Once", "Always Allow", "Decline", "Decline and Stop"]);
      const geometry = await card.evaluate((el) => {
        // Asked above the composer, below the conversation.
        const area = el.closest('[class*="_composerArea_"]')!;
        const transcript = area.parentElement!.querySelector('[class*="_stream_"]')!;
        const prompt = transcript.querySelector('[class*="_user_"]')!;
        const reply = transcript.querySelector('[class*="_agentCard_"]')!;
        const rect = el.getBoundingClientRect();
        const bounds = area.getBoundingClientRect();
        return {
          scroll: area.scrollWidth,
          client: area.clientWidth,
          inStream: transcript.contains(el),
          contained: rect.left >= bounds.left && rect.right <= bounds.right,
          below: rect.top >= transcript.getBoundingClientRect().bottom - 1,
          promptRadius: parseFloat(getComputedStyle(prompt).borderRadius),
          replyBackground: getComputedStyle(reply).backgroundColor,
          replyBorder: getComputedStyle(reply).borderTopWidth,
          userOnRight: prompt.getBoundingClientRect().right > reply.getBoundingClientRect().right,
          authorBeforeWork:
            transcript.querySelector('[class*="_agentAuthor_"]')?.nextElementSibling?.matches("details") ?? false,
          headAligned:
            Math.abs(
              prompt.getBoundingClientRect().right - prompt.previousElementSibling!.getBoundingClientRect().right,
            ) < 1,
          cardWidth: rect.width,
          available: bounds.width,
          replyFooter: reply.nextElementSibling != null,
        };
      });
      expect(geometry.scroll).toBe(geometry.client);
      expect(geometry.inStream).toBe(false);
      expect(geometry.contained).toBe(true);
      expect(geometry.below).toBe(true);
      expect(geometry.promptRadius).toBeLessThanOrEqual(6);
      // Replies read as plain text on the panel.
      expect(geometry.replyBackground).toBe("rgba(0, 0, 0, 0)");
      expect(geometry.replyBorder).toBe("0px");
      expect(geometry.userOnRight).toBe(true);
      expect(geometry.authorBeforeWork).toBe(true);
      expect(geometry.headAligned).toBe(true);
      // The turn waits on the approval: its interim message has no footer yet.
      expect(geometry.replyFooter).toBe(false);
      if (width === 760) expect(geometry.cardWidth).toBeGreaterThan(geometry.available * 0.8);
      await card.locator("pre").focus();
      for (const label of ["Allow Once", "Always Allow", "Decline", "Decline and Stop"]) {
        await page.keyboard.press("Tab");
        await expect(card.getByRole("button", { name: label, exact: true })).toBeFocused();
      }
      await page.evaluate(async () => {
        const path = "/src/platform/ipc.ts";
        const { commands } = await import(path);
        commands.agentRespond = async (task: string, permission: number, option: string) => {
          (window as unknown as { approvalAnswer: unknown }).approvalAnswer = { task, permission, option };
          return { status: "ok", data: null };
        };
      });
      await card.getByRole("button", { name: "Allow Once", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { approvalAnswer: unknown }).approvalAnswer))
        .toEqual({
          task: task.id,
          permission: 1,
          option: "once",
        });
    });
  }
}
