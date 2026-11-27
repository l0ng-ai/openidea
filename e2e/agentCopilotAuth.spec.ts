import type { Page } from "@playwright/test";
import type { AgentConfigOption, AgentProvider, CopilotAuthStatus } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openAgents(page: Page) {
  const settings = "/src/features/settings/model/staging.ts";
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).openSettings("agents.list"), settings);
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

test("unifies Copilot sign-in, gates per-account models on auth, and supports in-IDE account switching", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    let savedAccount = "";
    let cliAuthenticated = false;
    let ghAccounts: { login: string; active: boolean }[] = [{ login: "alice", active: true }];
    let loginChannel: unknown = null;

    const personalModel: AgentConfigOption = {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      current: "claude-sonnet-4.5",
      defaultValue: "claude-sonnet-4.5",
      via: "option",
      values: [
        { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: null },
        { value: "gpt-5", name: "GPT-5", description: null },
      ],
    };
    const workModel: AgentConfigOption = {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      current: "gemini-4-neon",
      defaultValue: "gemini-4-neon",
      via: "option",
      values: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon", description: null },
        { value: "gpt-5", name: "GPT-5", description: null },
      ],
    };

    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      agent_registry_list: () => ({ agents: [], warning: null }),
      agent_providers: () => {
        const env: Record<string, string> = { COPILOT_TELEMETRY_OPTOUT: "1" };
        if (savedAccount) env.OPENIDEA_COPILOT_GITHUB_ACCOUNT = savedAccount;
        const provider: AgentProvider = {
          id: "copilot",
          name: "GitHub Copilot",
          command: "copilot --headless --no-auto-update --stdio",
          program: "/tools/copilot",
          args: ["--headless", "--no-auto-update", "--stdio"],
          defaultProgram: "copilot",
          defaultArgs: ["--headless", "--no-auto-update", "--stdio"],
          loginHint: "Run `copilot login` in a terminal.",
          commandOverridden: false,
          commandEditable: false,
          commandReadOnlyReason: "registry",
          installed: true,
          canSignIn: true,
          canCheckCliUpdate: false,
          env,
          config: [workModel],
          thoughtLevels: {},
          commands: [],
          source: { kind: "registry", version: "1.0.116", update: null },
        };
        return [provider];
      },
      agent_copilot_auth_status: (): CopilotAuthStatus => ({
        authenticated: cliAuthenticated,
        login: cliAuthenticated ? "alice" : null,
        authType: cliAuthenticated ? "oauth" : null,
        statusMessage: cliAuthenticated ? "alice" : null,
        ghInstalled: true,
        ghAccounts,
      }),
      agent_refresh_models: () => ({
        provider: "copilot",
        config: [savedAccount === "alice-work" ? workModel : personalModel],
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      }),
      agent_set_env: ({ env }: { env: Record<string, string> }) => {
        savedAccount = env.OPENIDEA_COPILOT_GITHUB_ACCOUNT ?? "";
        return null;
      },
      agent_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        loginChannel = onEvent;
        setTimeout(() => {
          window.__ipc.send(loginChannel, { type: "output", data: "Opening GitHub in browser...\r\n" });
          cliAuthenticated = true;
          window.__ipc.send(loginChannel, { type: "exited", code: 0 });
        }, 40);
        return { id: 1, pid: 1001, title: "copilot" };
      },
      agent_gh_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        loginChannel = onEvent;
        setTimeout(() => {
          window.__ipc.send(loginChannel, { type: "output", data: "Logged in as alice-work\r\n" });
          ghAccounts = [
            { login: "alice", active: true },
            { login: "alice-work", active: false },
          ];
          window.__ipc.send(loginChannel, { type: "exited", code: 0 });
        }, 40);
        return { id: 2, pid: 1002, title: "gh" };
      },
      term_resize: () => null,
      term_write: () => null,
      term_kill: () => null,
    });
  });

  const dialog = await openAgents(page);
  const signIn = dialog.getByRole("region", { name: "Sign In" });
  const newTasks = dialog.getByRole("region", { name: "New Tasks" });
  const launch = dialog.getByRole("region", { name: "Launch" });

  // Unified Sign In section holds GitHub account; Launch has no duplicate account control.
  const accountSelect = signIn.getByRole("button", { name: "GitHub account" });
  await expect(accountSelect).toContainText("Copilot CLI default (not signed in)");
  await expect(launch.getByRole("button", { name: "GitHub account" })).toHaveCount(0);

  // Unauthenticated state hides stale cached models.
  await expect(newTasks.getByText("Sign in above to view and choose models available for this account.")).toBeVisible();
  await expect(newTasks.getByRole("button", { name: "Model" })).toHaveCount(0);

  // Sign In runs in-IDE PTY and unlocks personal account models.
  await signIn.getByRole("button", { name: "Sign In…" }).click();
  await expect(page.getByRole("dialog", { name: "Sign In to GitHub Copilot" })).toHaveCount(0);
  await expect(accountSelect).toContainText("Copilot CLI default (alice)");
  await expect(newTasks.getByRole("button", { name: "Model" })).toContainText("Agent's default (Claude Sonnet 4.5)");

  // Add account runs gh auth login in-IDE, auto-selects alice-work, and gates models on Apply.
  await signIn.getByRole("button", { name: "Add account…" }).click();
  await expect(page.getByRole("dialog", { name: "Sign In to GitHub CLI" })).toHaveCount(0);
  await expect(accountSelect).toContainText("alice-work");
  await expect(newTasks.getByText("Click Apply to load the models available for the selected account.")).toBeVisible();
  await expect(newTasks.getByRole("button", { name: "Model" })).toHaveCount(0);

  // Applying loads the new account's subscription models.
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(newTasks.getByRole("button", { name: "Model" })).toContainText("Agent's default (Gemini 4 Neon)");
  expect(await ipcCalls(page, "agent_set_env")).toEqual([
    {
      id: "copilot",
      env: {
        COPILOT_TELEMETRY_OPTOUT: "1",
        OPENIDEA_COPILOT_GITHUB_ACCOUNT: "alice-work",
      },
    },
  ]);
});
