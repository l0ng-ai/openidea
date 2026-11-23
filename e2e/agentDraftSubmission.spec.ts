import type { Page } from "@playwright/test";
import type { AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "draft-ack",
  title: "Draft acknowledgement",
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

async function prepare(page: Page, home: boolean, failure: boolean) {
  await page.evaluate(
    async ({ task, home, failure }) => {
      const storePath = "/src/features/agents/store.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const store = await import(storePath);
      const { commands } = await import(ipcPath);
      const provider = {
        id: "codex",
        name: "Codex",
        command: "codex",
        program: "codex",
        args: [],
        defaultProgram: null,
        defaultArgs: [],
        loginHint: null,
        commandOverridden: false,
        commandEditable: true,
        commandReadOnlyReason: null,
        installed: true,
        env: {},
        commands: [],
        source: { kind: "custom" },
        config: [],
        thoughtLevels: {},
      };
      // Delayed local acknowledgements exercise the real editor without starting an agent.
      commands.agentProviders = async () => ({ status: "ok", data: [provider] });
      commands.agentProbe = async () => ({ status: "ok", data: null });
      commands.agentChanges = async () => ({ status: "ok", data: [] });
      const acknowledge = (data: unknown, prompt: unknown) => {
        document.documentElement.dataset.submittedPrompt = JSON.stringify(prompt);
        return new Promise((resolve) =>
          document.addEventListener(
            "test:agent-ack",
            () => {
              resolve(
                failure
                  ? { status: "error", error: { kind: "internal", message: "Local send failed" } }
                  : { status: "ok", data },
              );
            },
            { once: true },
          ),
        );
      };
      commands.agentCreate = (request: { prompt: unknown }) => acknowledge(task, request.prompt);
      commands.agentPrompt = (_id: string, prompt: unknown) => acknowledge(null, prompt);
      store.useAgents.setState({
        loaded: true,
        providers: [provider],
        tasks: new Map([[task.id, task]]),
        entries: new Map([[task.id, []]]),
        composers: new Map(),
        draft: { provider: "codex", config: {}, isolation: "local", base: null },
        sessionLocation: "editor",
      });
      if (home) store.openHome();
      else store.openTask(task.id);
    },
    { task, home, failure },
  );
}

for (const home of [false, true]) {
  for (const edited of [false, true]) {
    for (const failure of [false, true]) {
      test(`${home ? "new task" : "session"}: ${failure ? "failed" : "successful"} acknowledgement with ${edited ? "new typing" : "unchanged draft"}`, async ({
        workbench: page,
      }) => {
        await prepare(page, home, failure);
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("submitted prompt");
        await page.getByRole("button", { name: home ? "Start" : "Send", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute(
          "data-submitted-prompt",
          JSON.stringify({ text: "submitted prompt", files: [], images: [] }),
        );
        await expect(page.getByRole("button", { name: home ? "Starting…" : "Send", exact: true })).toBeDisabled();
        if (edited) await box.fill("next unsent prompt");
        await page.evaluate(() => document.dispatchEvent(new Event("test:agent-ack")));
        if (home && !failure) {
          await expect(page.getByRole("tab", { name: "Draft acknowledgement" })).toBeVisible();
          await page.evaluate(async () => {
            const storePath = "/src/features/agents/store.ts";
            (await import(storePath)).openHome();
          });
        }
        const expected = edited ? "next unsent prompt" : failure ? "submitted prompt" : "";
        if (expected) await expect(box).toHaveText(expected);
        else await expect(box.locator(".cm-placeholder")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              async (key) => {
                const storePath = "/src/features/agents/store.ts";
                return (await import(storePath)).composerDraft(key).text;
              },
              home ? "home" : task.id,
            ),
          )
          .toBe(expected);
        await expect(page.getByRole("button", { name: home ? "Start" : "Send", exact: true })).toBeEnabled({
          enabled: !!expected,
        });
      });
    }
  }
}

test("short prompts fit before and after a completed agent exchange", async ({ workbench: page }) => {
  await prepare(page, true, false);
  const box = page.getByRole("textbox", { name: "Message", exact: true }).filter({ visible: true });
  const scroller = page.locator(".cm-scroller").filter({ has: box });
  const overflow = () =>
    scroller.evaluate((el) => ({
      x: el.scrollWidth - el.clientWidth,
      y: el.scrollHeight - el.clientHeight,
    }));

  await expect(box.locator(".cm-placeholder")).toBeVisible();
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });
  await box.fill("Reply with OK.");
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-submitted-prompt", /Reply with OK/);
  await page.evaluate(() => document.dispatchEvent(new Event("test:agent-ack")));
  await expect(page.getByRole("tab", { name: task.title })).toBeVisible();
  await page.evaluate(async (id) => {
    const storePath = "/src/features/agents/store.ts";
    const { useAgents } = await import(storePath);
    useAgents.setState({
      entries: new Map([
        [
          id,
          [
            { type: "user", text: "Reply with OK.", attachments: [] },
            { type: "agent", text: "OK" },
          ],
        ],
      ]),
    });
  }, task.id);
  await expect(page.getByText("OK", { exact: true })).toBeVisible();
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "New Agent Task", exact: true }).click();
  await expect(box.locator(".cm-placeholder")).toBeVisible();
  await expect(scroller).toHaveCSS("overflow-x", "hidden");
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });
  await box.fill("Short draft");
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });

  await box.fill("word".repeat(2000));
  await expect(scroller).toHaveCSS("overflow-y", "auto");
  await expect
    .poll(async () => {
      const { x, y } = await overflow();
      return x === 0 && y > 0;
    })
    .toBe(true);
  await box.fill("");
  await expect(box.locator(".cm-placeholder")).toBeVisible();
  await expect.poll(overflow).toEqual({ x: 0, y: 0 });
});
