import { expect, test } from "./fixtures";
import type { AgentQuestion, AgentTask } from "../src/bindings";

const task: AgentTask = {
  id: "questions",
  title: "Plan the change",
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
const questions: AgentQuestion[] = [
  {
    header: "Layout",
    question: "Which layout should we use?",
    multiSelect: false,
    options: [{ label: "Table", description: "One row per check", preview: "| check | result |" }],
  },
  {
    header: "Checks",
    question: "Which checks should we include? " + "Explain the checks and their expected results. ".repeat(8),
    multiSelect: true,
    options: [
      { label: "LongOption".repeat(20), description: "Description ".repeat(25), preview: null },
      { label: "Updates", description: "Check for updates", preview: null },
    ],
  },
  {
    header: "Delivery",
    question: "When should the change ship?",
    multiSelect: false,
    options: [{ label: "Today", description: "After the checks pass", preview: null }],
  },
];

for (const theme of ["dark", "light"] as const) {
  for (const width of [760, 1400]) {
    for (const count of [1, 3]) {
      test(`${count} questions at ${width}px in ${theme}`, async ({ workbench: page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          async ({ task, questions, theme }) => {
            const storePath = "/src/features/agents/store.ts";
            const themePath = "/src/workbench/theme.ts";
            const ipcPath = "/src/platform/ipc.ts";
            const store = await import(storePath);
            (await import(themePath)).previewTheme(theme);
            // Keep this fixture entirely local, including submission.
            (await import(ipcPath)).commands.agentRespond = async (
              _task: string,
              _permission: number,
              answer: string,
            ) => {
              document.documentElement.dataset.questionAnswer = answer;
              return { status: "ok", data: null };
            };
            store.useAgents.setState({
              loaded: true,
              tasks: new Map([[task.id, task]]),
              entries: new Map([
                [
                  task.id,
                  [{ type: "permission", id: 1, title: "Plan the change", options: [], chosen: null, questions }],
                ],
              ]),
            });
            store.openTaskInEditorLocation(task.id);
          },
          { task, questions: questions.slice(0, count), theme },
        );
        const card = page.getByRole("form", { name: "Plan the change" });
        await expect(card).toBeVisible();
        const submit = card.getByRole("button", { name: "Submit", exact: true });
        await expect(submit).toBeDisabled();
        if (count === 1) {
          await expect(card.getByRole("tablist")).toHaveCount(0);
          await expect(card.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
          await card.getByRole("radio", { name: /^Table/ }).check();
          await expect(submit).toBeEnabled();
          await card.getByRole("radio", { name: /^Other/ }).check();
          await card.getByPlaceholder("Type your answer").fill("Custom layout");
          await page.keyboard.press("Enter");
          await expect(page.locator("html")).toHaveAttribute(
            "data-question-answer",
            JSON.stringify({ [questions[0]!.question]: ["Custom layout"] }),
          );
          return;
        }
        const tabs = card.getByRole("tab");
        await expect(tabs).toHaveCount(3);
        await expect(card.getByRole("button", { name: "Next", exact: true })).toBeInViewport({ ratio: 1 });
        const initial = await card.boundingBox();
        await tabs.first().focus();
        await page.keyboard.press("ArrowRight");
        await expect(tabs.nth(1)).toBeFocused();
        await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Tab");
        await expect(card.getByRole("tabpanel", { name: "Checks" })).toBeFocused();
        await expect(card.getByRole("tabpanel")).toHaveCount(1);
        await expect(card.getByText("| check | result |", { exact: true })).toBeHidden();
        const geometry = await card.evaluate((el) => ({
          width: el.clientWidth,
          scroll: el.scrollWidth,
          panelWidth: el.querySelector('[role="tabpanel"][aria-hidden="false"]')!.clientWidth,
          panelScroll: el.querySelector('[role="tabpanel"][aria-hidden="false"]')!.scrollWidth,
        }));
        expect(geometry.scroll).toBe(geometry.width);
        expect(geometry.panelScroll).toBe(geometry.panelWidth);
        await card.getByRole("checkbox", { name: /^LongOption/ }).check();
        const panels = card.getByRole("tabpanel", { name: "Checks" }).locator("..");
        await panels.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await expect(tabs.nth(1)).toBeInViewport({ ratio: 1 });
        await card.getByRole("button", { name: "Next", exact: true }).click();
        await expect(card.getByRole("tabpanel", { name: "Delivery" })).toBeFocused();
        expect(
          await card
            .getByRole("tabpanel", { name: "Delivery" })
            .locator("..")
            .evaluate((el) => el.scrollTop),
        ).toBe(0);
        await card.getByRole("radio", { name: /^Today/ }).check();
        await card.getByRole("button", { name: "Previous", exact: true }).click();
        await expect(card.getByRole("tabpanel", { name: "Checks" })).toBeFocused();
        await expect(card.getByRole("checkbox", { name: /^LongOption/ })).toBeChecked();
        await tabs.nth(1).focus();
        await page.keyboard.press("Home");
        await expect(tabs.first()).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(card.getByRole("tabpanel", { name: "Layout" })).toBeFocused();
        await page.keyboard.press("1");
        await expect(card.getByRole("radio", { name: /^Table/ })).toBeChecked();
        await expect(submit).toBeEnabled();
        expect((await card.boundingBox())!.height).toBeCloseTo(initial!.height, 0);
        await submit.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("html")).toHaveAttribute(
          "data-question-answer",
          JSON.stringify({
            [questions[0]!.question]: ["Table"],
            [questions[1]!.question]: [questions[1]!.options[0]!.label],
            [questions[2]!.question]: ["Today"],
          }),
        );
      });
    }
  }
}
