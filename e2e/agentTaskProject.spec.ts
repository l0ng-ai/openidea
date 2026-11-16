import type { Page } from "@playwright/test";
import type { AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "source-a",
  title: "Source task in A",
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
  capabilities: { fork: true },
};

async function prepare(page: Page, kind: "create" | "fork", failure: boolean, holdClose = false, closeFailure = false) {
  await page.evaluate(
    async ({ task, kind, failure, holdClose, closeFailure }) => {
      const storePath = "/src/features/agents/store.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const projectPath = "/src/platform/project.ts";
      const trustPath = "/src/platform/projectTrust.ts";
      const contributionsPath = "/src/workbench/contributions.ts";
      const store = await import(storePath);
      const { commands } = await import(ipcPath);
      const project = await import(projectPath);
      const initial = project.useProject.getState().project;
      (await import(trustPath)).provideProjectTrustPrompt(async () => true);
      commands.openProject = async (root: string) => ({
        status: "ok",
        data: {
          ...initial,
          root,
          name: root === task.cwd ? "acme-api" : "project-b",
          trusted: true,
        },
      });
      commands.closeProject = async () => {};
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
      commands.agentProviders = async () => ({ status: "ok", data: [provider] });
      commands.agentProbe = async () => ({ status: "ok", data: null });
      commands.agentEntries = async () => ({ status: "ok", data: [] });
      commands.agentChanges = async () => ({ status: "ok", data: [] });
      const complete = () => {
        document.documentElement.dataset.taskRequest = "pending";
        return new Promise((resolve) =>
          document.addEventListener(
            "test:task-complete",
            () => {
              resolve(
                failure
                  ? { status: "error", error: { kind: "internal", message: "Local operation failed" } }
                  : { status: "ok", data: { ...task, id: "completed-a", title: "Task from project A" } },
              );
              setTimeout(() => {
                document.documentElement.dataset.taskRequest = "settled";
              }, 0);
            },
            { once: true },
          ),
        );
      };
      commands.agentCreate = complete;
      commands.agentFork = complete;
      if (holdClose) {
        const editors = (await import(contributionsPath)).editorService();
        const close = editors.closeInput;
        editors.closeInput = async (key: string) => {
          const closed = await close(key);
          if (key !== "agent:new") return closed;
          document.documentElement.dataset.homeClosing = "pending";
          await new Promise((resolve, reject) =>
            document.addEventListener(
              "test:close-complete",
              () => {
                if (closeFailure) reject(new Error("Local close failed"));
                else resolve(null);
                setTimeout(() => {
                  document.documentElement.dataset.homeClosing = "settled";
                }, 0);
              },
              { once: true },
            ),
          );
          return closed;
        };
      }
      store.useAgents.setState({
        loaded: true,
        tasks: new Map([[task.id, task]]),
        providers: [provider],
        composers: new Map(),
        history: [],
        entries: new Map([[task.id, [{ type: "user", text: "Existing prompt in A", attachments: [] }]]]),
        draft: { provider: "codex", config: {}, isolation: "local", base: null },
        sessionLocation: "editor",
      });
      if (kind === "create") store.openHome("Submitted task in A");
      else store.openTask(task.id);
    },
    { task, kind, failure, holdClose, closeFailure },
  );
  if (kind === "create") await page.getByRole("button", { name: "Start", exact: true }).click();
  else {
    await page.getByText("Existing prompt in A", { exact: true }).hover();
    await page.getByRole("button", { name: "Fork", exact: true }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-task-request", "pending");
}

async function changeProject(page: Page, change: "A to B" | "A to B to A" | "reopen A") {
  await page.evaluate(
    async ({ change, task }) => {
      const storePath = "/src/features/agents/store.ts";
      const projectPath = "/src/platform/project.ts";
      const store = await import(storePath);
      const project = await import(projectPath);
      if (change === "reopen A") await project.closeProject();
      else await project.openProject("/dev/project-b");
      if (change !== "A to B") await project.openProject(task.cwd);
      const root = project.useProject.getState().project.root;
      store.useAgents.setState({
        loaded: true,
        tasks: new Map([
          ["current-project", { ...task, id: "current-project", title: "Current project's task", cwd: root }],
        ]),
        entries: new Map(),
        history: ["Current project history"],
      });
      store.openHome("Current project draft");
    },
    { change, task },
  );
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Current project draft");
}

async function expectCurrentProject(page: Page) {
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveText("Current project draft");
  await expect(page.getByRole("tab", { name: "New Agent Task" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Task from project A" })).toHaveCount(0);
  await expect(page.getByText(/Local (operation|close) failed/)).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
      return { tasks: [...store.useAgents.getState().tasks.keys()], history: store.useAgents.getState().history };
    }),
  ).toEqual({ tasks: ["current-project"], history: ["Current project history"] });
}

for (const kind of ["create", "fork"] as const) {
  for (const failure of [false, true]) {
    for (const change of ["A to B", "A to B to A", "reopen A"] as const) {
      test(`${kind}: old ${failure ? "failure" : "success"} after ${change}`, async ({ workbench: page }) => {
        await prepare(page, kind, failure);
        await changeProject(page, change);
        await page.evaluate(() => document.dispatchEvent(new Event("test:task-complete")));
        await expect(page.locator("html")).toHaveAttribute("data-task-request", "settled");
        await expectCurrentProject(page);
      });
    }
    test(`${kind}: ${failure ? "failure" : "success"} in the current project`, async ({ workbench: page }) => {
      await prepare(page, kind, failure);
      await page.evaluate(() => document.dispatchEvent(new Event("test:task-complete")));
      await expect(page.locator("html")).toHaveAttribute("data-task-request", "settled");
      if (failure) await expect(page.getByText(/Local operation failed/).first()).toBeVisible();
      else await expect(page.getByRole("tab", { name: "Task from project A" })).toBeVisible();
    });
  }
}

for (const closeFailure of [false, true]) {
  test(`create: project changes while Home closes (${closeFailure ? "failure" : "success"})`, async ({
    workbench: page,
  }) => {
    await prepare(page, "create", false, true, closeFailure);
    await page.evaluate(() => document.dispatchEvent(new Event("test:task-complete")));
    await expect(page.locator("html")).toHaveAttribute("data-home-closing", "pending");
    await changeProject(page, "A to B to A");
    await page.evaluate(() => document.dispatchEvent(new Event("test:close-complete")));
    await expect(page.locator("html")).toHaveAttribute("data-home-closing", "settled");
    await expectCurrentProject(page);
  });
}
