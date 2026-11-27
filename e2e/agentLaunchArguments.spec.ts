import type { Page } from "@playwright/test";
import type { AgentProvider } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openAgents(page: Page) {
  // Load the Settings module in the Vite browser realm, not Playwright's Node process.
  const settings = "/src/features/settings/model/staging.ts";
  await page.evaluate(async (path) => (await import(/* @vite-ignore */ path)).openSettings("agents.list"), settings);
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

test("applies and resets built-in ACP arguments without changing the executable or environment", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    let extra: string[] = [];
    Object.assign(window.__ipc.handlers, {
      agent_providers: () => {
        const provider = {
          id: "omp",
          name: "OMP",
          command: "/opt/my tools/omp acp",
          program: "/opt/my tools/omp",
          args: ["acp", ...extra],
          additionalArgs: extra,
          defaultProgram: "omp",
          defaultArgs: ["acp"],
          loginHint: null,
          commandOverridden: true,
          commandEditable: true,
          commandReadOnlyReason: null,
          installed: true,
          env: { OMP_SETTING: "value" },
          config: [],
          commands: [],
          source: { kind: "builtin" },
        } satisfies AgentProvider;
        return [provider];
      },
      agent_registry_list: () => ({ agents: [], warning: null }),
      agent_set_additional_args: ({ args }: { args: string[] }) => {
        extra = args;
        return null;
      },
      settings_get_global: () => ({}),
    });
  });
  const dialog = await openAgents(page);
  const launch = dialog.getByRole("region", { name: "Launch" });
  await expect(launch.getByRole("textbox", { name: "Executable" })).toHaveValue("/opt/my tools/omp");
  const args = launch.getByRole("textbox", { name: "Additional arguments" });
  const apply = dialog.getByRole("button", { name: "Apply", exact: true });

  await args.fill('--label "two words" ""');
  await apply.click();
  await expect(launch.getByText("'/opt/my tools/omp' acp --label 'two words' ''", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "agent_set_additional_args")).toEqual([
    { id: "omp", args: ["--label", "two words", ""] },
  ]);

  await args.fill("--discard");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openAgents(page);
  await expect(args).toHaveValue("--label 'two words' ''");
  await launch.getByRole("button", { name: "Reset additional arguments" }).click();
  await apply.click();
  await expect(launch.getByText("'/opt/my tools/omp' acp", { exact: true })).toBeVisible();
  await expect(args).toHaveValue("");
  await expect(launch.getByRole("textbox", { name: "Executable" })).toHaveValue("/opt/my tools/omp");
  await expect(launch.getByRole("textbox", { name: "Environment variables" })).toHaveValue("OMP_SETTING=value");
  expect(await ipcCalls(page, "agent_set_additional_args")).toEqual([
    { id: "omp", args: ["--label", "two words", ""] },
    { id: "omp", args: [] },
  ]);
});
