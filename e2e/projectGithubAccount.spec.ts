import type { Page } from "@playwright/test";
import type { GhProjectAccountStatus } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openGithubSettings(page: Page) {
  const settings = "/src/features/settings/model/staging.ts";
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).openSettings("vcs.github"), settings);
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

test("suggests and configures a project-scoped GitHub account in Settings › Version Control › GitHub", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    let configuredAccount = "";
    const makeStatus = (): GhProjectAccountStatus => ({
      ghInstalled: true,
      accounts: [
        { login: "alice", active: true },
        { login: "alice-work", active: false },
      ],
      configuredAccount,
      effectiveAccount: configuredAccount || "alice",
      suggestedAccount: configuredAccount ? null : "alice-work",
    });
    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      gh_project_account_status: () => makeStatus(),
      gh_set_project_account: ({ account }: { account: string }) => {
        configuredAccount = account;
        return makeStatus();
      },
    });
  });

  const dialog = await openGithubSettings(page);
  const select = dialog.getByRole("button", { name: "GitHub account" });
  await expect(select).toContainText("Automatic (alice)");
  await expect(
    dialog.getByText("Uses GitHub CLI's active account without setting GH_TOKEN in the project environment."),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Use alice-work for this project" }).click();
  await expect(select).toContainText("alice-work");
  await expect(
    dialog.getByText(
      "Passes this account's GH_TOKEN to processes started in this project (terminals, agents, Git, and run configurations).",
    ),
  ).toBeVisible();
  expect(await ipcCalls(page, "gh_set_project_account")).toEqual([{ account: "alice-work" }]);
});

test("adds a GitHub account in Settings › Version Control › GitHub with OAuth device-code banner", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await stubDesktop(page);
  await page.evaluate(() => {
    let configuredAccount = "";
    let accounts = [{ login: "alice", active: true }];
    let loginChannel: unknown = null;
    const makeStatus = (): GhProjectAccountStatus => ({
      ghInstalled: true,
      accounts,
      configuredAccount,
      effectiveAccount: configuredAccount || accounts.find((a) => a.active)?.login || null,
      suggestedAccount: null,
    });
    (window as unknown as { __finishGhLogin?: () => void }).__finishGhLogin = () => {
      accounts = [
        { login: "alice", active: true },
        { login: "alice-work", active: false },
      ];
      window.__ipc.send(loginChannel, { type: "exited", code: 0 });
    };
    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      gh_project_account_status: () => makeStatus(),
      gh_set_project_account: ({ account }: { account: string }) => {
        configuredAccount = account;
        return makeStatus();
      },
      agent_gh_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        loginChannel = onEvent;
        setTimeout(() => {
          window.__ipc.send(onEvent, {
            type: "output",
            data:
              "! First copy your one-time code: AB12-CD34\r\n" +
              "Press Enter to open https://github.com/login/device in your browser...\r\n",
          });
        }, 40);
        return { id: 101, pid: 5001, title: "gh" };
      },
      term_resize: () => null,
      term_write: () => null,
      term_kill: () => null,
    });
  });

  const dialog = await openGithubSettings(page);
  await expect(dialog.getByRole("button", { name: "GitHub account" })).toContainText("Automatic (alice)");
  const addBtn = dialog.getByRole("button", { name: "Add account…" });
  await expect(addBtn).toBeVisible();

  const screenshotDir = process.env.CAPTURE_GH_SIGNIN_SCREENSHOTS;
  if (screenshotDir) {
    await page.waitForTimeout(150);
    await dialog.screenshot({ path: `${screenshotDir}/after-settings-github.png`, animations: "disabled" });
  }

  await addBtn.click();
  const signInDialog = page.getByRole("dialog", { name: "Sign In to GitHub CLI" });
  await expect(signInDialog).toBeVisible();
  const deviceBanner = signInDialog.getByRole("region", { name: "Device verification code" });
  await expect(deviceBanner.getByText("AB12-CD34", { exact: true })).toBeVisible();
  await expect(deviceBanner.getByRole("button", { name: "Copy Code & Open Browser" })).toBeVisible();

  if (screenshotDir) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${screenshotDir}/after-settings-github-device-code.png`, animations: "disabled" });
  }

  await page.evaluate(() => (window as unknown as { __finishGhLogin?: () => void }).__finishGhLogin?.());
  await expect(signInDialog).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "GitHub account" })).toContainText("alice-work");
});

test("signs in via the in-IDE GitHub CLI dialog from Pull Requests and Clone Repository", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await stubDesktop(page);
  await page.evaluate(() => {
    let signedIn = false;
    let loginChannel: unknown = null;
    (window as unknown as { __finishGhLogin?: () => void }).__finishGhLogin = () => {
      signedIn = true;
      window.__ipc.send(loginChannel, { type: "exited", code: 0 });
    };
    Object.assign(window.__ipc.handlers, {
      settings_get_global: () => ({}),
      vcs_roots: () => [{ root: "/dev/acme-api", name: "acme-api", branch: "main" }],
      vcs_remotes: () => [{ name: "origin", url: "https://github.com/acme/api.git", resolvedUrl: null }],
      gh_project_account_status: (): GhProjectAccountStatus => ({
        ghInstalled: true,
        accounts: signedIn ? [{ login: "alice", active: true }] : [],
        configuredAccount: "",
        effectiveAccount: signedIn ? "alice" : null,
        suggestedAccount: null,
      }),
      gh_availability: () =>
        signedIn
          ? { kind: "ready", login: "alice", repo: { nameWithOwner: "acme/api", url: "https://github.com/acme/api" } }
          : { kind: "notLoggedIn", message: "not logged in" },
      gh_api: ({ request }: { request: { endpoint: string } }) => {
        if (request.endpoint === "user") return JSON.stringify({ login: "alice", id: 1 });
        return JSON.stringify({
          data: {
            repository: {
              id: "R1",
              owner: { __typename: "Organization", id: "O1", login: "acme" },
              nameWithOwner: "acme/api",
              viewerPermission: "WRITE",
              mergeCommitAllowed: true,
              squashMergeAllowed: true,
              rebaseMergeAllowed: true,
              defaultBranchRef: { name: "main" },
              isFork: false,
              url: "https://github.com/acme/api",
              sshUrl: "git@github.com:acme/api.git",
            },
            viewer: { __typename: "User", id: "U1", login: "alice", url: "https://github.com/alice", avatarUrl: "" },
            search: {
              pageInfo: { startCursor: null, endCursor: null, hasNextPage: false, hasPreviousPage: false },
              nodes: [],
            },
          },
        });
      },
      gh_account_repos: () =>
        signedIn
          ? {
              kind: "ready",
              login: "alice",
              repos: [
                {
                  nameWithOwner: "acme/api",
                  description: "Backend service",
                  private: true,
                  fork: false,
                  archived: false,
                  cloneUrl: "https://github.com/acme/api.git",
                },
              ],
            }
          : { kind: "notLoggedIn", message: "not logged in" },
      agent_gh_login_spawn: ({ onEvent }: { onEvent: unknown }) => {
        loginChannel = onEvent;
        setTimeout(() => {
          window.__ipc.send(onEvent, {
            type: "output",
            data:
              "! First copy your one-time code: 9F8E-7D6C\r\n" +
              "Press Enter to open https://github.com/login/device in your browser...\r\n",
          });
        }, 40);
        return { id: 102, pid: 5002, title: "gh" };
      },
      term_resize: () => null,
      term_write: () => null,
      term_kill: () => null,
    });
  });

  // 1. Open Clone Repository › GitHub while signed out.
  await page.evaluate(async () => {
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("vcs.clone");
  });
  const cloneDialog = page.getByRole("dialog", { name: "Clone Repository" });
  await expect(cloneDialog).toBeVisible();
  await cloneDialog
    .getByRole("complementary", { name: "Clone source" })
    .getByRole("button", { name: "GitHub" })
    .click();
  await expect(cloneDialog.getByText("Not logged in to GitHub")).toBeVisible();
  const cloneSignInBtn = cloneDialog.getByRole("button", { name: "Sign In…" });
  await expect(cloneSignInBtn).toBeVisible();

  const screenshotDir = process.env.CAPTURE_GH_SIGNIN_SCREENSHOTS;
  if (screenshotDir) {
    await page.waitForTimeout(150);
    await cloneDialog.screenshot({ path: `${screenshotDir}/after-clone-not-logged-in.png`, animations: "disabled" });
  }

  // Close Clone dialog and test Pull Requests tool window Sign In… flow.
  await cloneDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(cloneDialog).toHaveCount(0);

  await page.evaluate(async () => {
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("github.pullRequests");
  });
  await expect(page.getByText("Not logged in to GitHub")).toBeVisible();
  const prSignInBtn = page.getByRole("button", { name: "Sign In…" });
  await expect(prSignInBtn).toBeVisible();

  if (screenshotDir) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${screenshotDir}/after-pr-not-logged-in.png`, animations: "disabled" });
  }

  await prSignInBtn.click();
  const signInDialog = page.getByRole("dialog", { name: "Sign In to GitHub CLI" });
  await expect(signInDialog).toBeVisible();
  const deviceBanner = signInDialog.getByRole("region", { name: "Device verification code" });
  await expect(deviceBanner.getByText("9F8E-7D6C", { exact: true })).toBeVisible();
  await expect(deviceBanner.getByRole("button", { name: "Copy Code & Open Browser" })).toBeVisible();

  await page.evaluate(() => (window as unknown as { __finishGhLogin?: () => void }).__finishGhLogin?.());
  await expect(signInDialog).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search pull requests" })).toBeVisible();

  // Reopen Clone Repository › GitHub now that gh is signed in.
  await page.evaluate(async () => {
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("vcs.clone");
  });
  await expect(cloneDialog).toBeVisible();
  await cloneDialog
    .getByRole("complementary", { name: "Clone source" })
    .getByRole("button", { name: "GitHub" })
    .click();
  await expect(cloneDialog.getByRole("option", { name: /acme\/api/ })).toBeVisible();
  await expect(cloneDialog.getByRole("button", { name: "Add account…" })).toBeVisible();

  if (screenshotDir) {
    await page.waitForTimeout(150);
    await cloneDialog.screenshot({ path: `${screenshotDir}/after-clone-signed-in.png`, animations: "disabled" });
  }
});
