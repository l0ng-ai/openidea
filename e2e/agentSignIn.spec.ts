import type { Page } from "@playwright/test";
import type { AgentConfigOption, AgentProvider } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openAgents(page: Page) {
  const settings = "/src/features/settings/model/staging.ts";
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).openSettings("agents.list"), settings);
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

test("signs in to an agent in an IDE terminal dialog and refreshes its model catalog", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    const model: AgentConfigOption = {
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
    let signedIn = false;
    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      agent_registry_list: () => ({ agents: [], warning: null }),
      agent_providers: () => {
        const provider: AgentProvider = {
          id: "claude",
          name: "Claude Code",
          command: "claude",
          program: "/Users/alice/Library/Application Support/ai.l0ng.openidea/agents/tools/claude/claude",
          args: [],
          defaultProgram: "claude",
          defaultArgs: [],
          loginHint:
            "Run `'/Users/alice/Library/Application Support/ai.l0ng.openidea/agents/tools/claude/claude'` in a terminal and sign in.",
          commandOverridden: false,
          commandEditable: false,
          commandReadOnlyReason: "registry",
          installed: true,
          canSignIn: true,
          canCheckCliUpdate: false,
          env: {},
          config: signedIn ? [model] : [],
          thoughtLevels: {},
          commands: [],
          source: { kind: "registry", version: "1.0.0", update: null },
        };
        return [provider];
      },
      agent_refresh_models: () => ({
        provider: "claude",
        config: signedIn ? [model] : [],
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: signedIn ? Date.now() : null,
        retryAtMs: null,
        error: null,
      }),
      agent_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        setTimeout(() => {
          window.__ipc.send(onEvent, { type: "output", data: "Opening Claude in browser...\r\n" });
          signedIn = true;
          window.__ipc.send(onEvent, { type: "exited", code: 0 });
        }, 40);
        return { id: 1, pid: 1001, title: "claude" };
      },
      term_resize: () => null,
      term_write: () => null,
      term_kill: () => null,
    });
  });

  const dialog = await openAgents(page);
  const signIn = dialog.getByRole("region", { name: "Sign In" });
  const newTasks = dialog.getByRole("region", { name: "New Tasks" });
  await expect(newTasks.getByRole("button", { name: "Model" })).toHaveCount(0);

  await signIn.getByRole("button", { name: "Sign In…" }).click();
  await expect(page.getByRole("dialog", { name: "Sign In to Claude Code" })).toHaveCount(0);
  await expect(newTasks.getByRole("button", { name: "Model" })).toContainText("Agent's default (Claude Sonnet 4.5)");
  expect((await ipcCalls(page, "agent_login_spawn")).map((c) => c.id)).toEqual(["claude"]);
});

test("surfaces a device-code banner during sign-in with one-click copy and browser launch", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    const model: AgentConfigOption = {
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
    let signedIn = false;
    let loginChannel: unknown = null;
    (window as unknown as { __finishDeviceLogin?: () => void }).__finishDeviceLogin = () => {
      signedIn = true;
      window.__ipc.send(loginChannel, { type: "exited", code: 0 });
    };
    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      agent_registry_list: () => ({ agents: [], warning: null }),
      agent_providers: () => {
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
          env: {},
          config: signedIn ? [model] : [],
          thoughtLevels: {},
          commands: [],
          source: { kind: "registry", version: "1.0.116", update: null },
        };
        return [provider];
      },
      agent_copilot_auth_status: () => ({
        authenticated: signedIn,
        login: signedIn ? "alice" : null,
        authType: signedIn ? "oauth" : null,
        statusMessage: signedIn ? "alice" : null,
        ghInstalled: true,
        ghAccounts: [],
      }),
      agent_refresh_models: () => ({
        provider: "copilot",
        config: signedIn ? [model] : [],
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: signedIn ? Date.now() : null,
        retryAtMs: null,
        error: null,
      }),
      agent_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        loginChannel = onEvent;
        setTimeout(() => {
          window.__ipc.send(onEvent, {
            type: "output",
            data: "Waiting for authorization...\r\nEnter one-time code: \u001b[1mWDJB-MJHT\u001b[0m at https://github.com/login/device\r\n",
          });
        }, 30);
        return { id: 1, pid: 1001, title: "copilot" };
      },
      clipboard_write_text: () => null,
      "plugin:opener|open_url": () => null,
      term_resize: () => null,
      term_write: () => null,
      term_kill: () => null,
    });
  });

  const dialog = await openAgents(page);
  await dialog.getByRole("region", { name: "Sign In" }).getByRole("button", { name: "Sign In…" }).click();

  const signInDialog = page.getByRole("dialog", { name: "Sign In to GitHub Copilot" });
  const banner = signInDialog.getByRole("region", { name: "Device verification code" });
  await expect(banner).toBeVisible();
  await expect(banner.getByText("WDJB-MJHT")).toBeVisible();
  await expect(banner.getByText("github.com/login/device")).toBeVisible();

  await banner.getByRole("button", { name: "Copy Code & Open Browser" }).click();
  await expect(banner.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => ipcCalls(page, "clipboard_write_text")).toEqual([{ text: "WDJB-MJHT" }]);
  await expect
    .poll(() => ipcCalls(page, "plugin:opener|open_url"))
    .toEqual([{ url: "https://github.com/login/device" }]);

  await page.evaluate(() => (window as unknown as { __finishDeviceLogin?: () => void }).__finishDeviceLogin?.());
  await expect(signInDialog).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "New Tasks" }).getByRole("button", { name: "Model" })).toContainText(
    "Agent's default (Claude Sonnet 4.5)",
  );
});
