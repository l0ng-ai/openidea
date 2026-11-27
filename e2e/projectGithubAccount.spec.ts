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
