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
    options: [
      { id: "once", kind: "allow_once", name: "Allow once" },
      { id: "always", kind: "allow_always", name: `Always allow \`${command}\`` },
      { id: "decline", kind: "reject_once", name: "Decline" },
      { id: "cancel", kind: "reject_once", name: "Decline and stop" },
    ],
    chosen: null,
  },
];

for (const theme of ["dark", "light"] as const) {
  for (const width of [760, 1400]) {
    test(`approval stays inside a flat transcript at ${width}px in ${theme}`, async ({ page }) => {
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
        const transcript = el.parentElement!;
        const prompt = transcript.querySelector('[class*="_user_"]')!;
        const reply = transcript.querySelector('[class*="_agentCard_"]')!;
        const rect = el.getBoundingClientRect();
        const bounds = transcript.getBoundingClientRect();
        return {
          scroll: transcript.scrollWidth,
          client: transcript.clientWidth,
          contained: rect.left >= bounds.left && rect.right <= bounds.right,
          promptRadius: parseFloat(getComputedStyle(prompt).borderRadius),
          replyBackground: getComputedStyle(reply).backgroundColor,
          replyBorder: getComputedStyle(reply).borderTopWidth,
          leftAligned: Math.abs(prompt.getBoundingClientRect().left - reply.getBoundingClientRect().left) < 1,
        };
      });
      expect(geometry.scroll).toBe(geometry.client);
      expect(geometry.contained).toBe(true);
      expect(geometry.promptRadius).toBeLessThanOrEqual(4);
      expect(geometry.replyBackground).toBe("rgba(0, 0, 0, 0)");
      expect(geometry.replyBorder).toBe("0px");
      expect(geometry.leftAligned).toBe(true);
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
