import type { Locator } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const NAME = "Quarterly Reconciliation Dashboard";
const PATH = "/work/portfolio/finance/quarterly-reconciliation-dashboard";
const BRANCH = "feature/statement-reconciliation-and-quarterly-balances";
const HOST = "build-lab";
const REMOTE_PATH = "/apps/payment-ledger";

async function expectBelow(option: Locator, upper: string, lower: string) {
  await expect
    .poll(
      async () => {
        const first = await option.getByText(upper, { exact: true }).boundingBox();
        const second = await option.getByText(lower, { exact: true }).boundingBox();
        return !!first && !!second && second.y >= first.y + first.height - 1;
      },
      { message: `Expected "${lower}" on its own line below "${upper}"` },
    )
    .toBe(true);
}

test("project switcher keeps names and metadata on separate lines and highlights remote matches", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 440, height: 700 });
  await stubDesktop(page);
  await page.evaluate(
    ({ name, path, branch, host, remotePath }) => {
      const handlers = window.__ipc.handlers;
      handlers.recent_projects = () => [{ name, path, branch, openedAtMs: 1 }];
      handlers.recent_project_groups = () => [{ name: "Release Tools", paths: [path], expanded: true }];
      handlers.window_open_projects = () => [
        { name: "acme-api", root: "/dev/acme-api", remote: null },
        { name: "Payment Ledger", root: remotePath, remote: { kind: "ssh", config: host } },
      ];
      handlers.window_open_project = () => null;
    },
    { name: NAME, path: PATH, branch: BRANCH, host: HOST, remotePath: REMOTE_PATH },
  );

  await page.getByRole("button", { name: "acme-api", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Projects" });
  await expect(popup.getByText("Release Tools")).toBeVisible();
  const local = popup.getByRole("option", { name: new RegExp(NAME) });
  await expectBelow(local, NAME, PATH);
  await expectBelow(local, PATH, BRANCH);
  expect(await local.getByText(NAME, { exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
    true,
  );

  const remote = popup.getByRole("option", { name: /Payment Ledger/ });
  await expectBelow(remote, "Payment Ledger", HOST);
  await expectBelow(remote, HOST, REMOTE_PATH);

  await page.setViewportSize({ width: 960, height: 700 });
  await page.keyboard.type(HOST);
  await expect(remote).toHaveAttribute("aria-selected", "true");
  await expect(remote.locator("mark")).toHaveText(HOST);
  await page.keyboard.press("Escape");
  await page.keyboard.type("/apps");
  await expect(remote.locator("mark")).toHaveText("/apps");

  await page.keyboard.press("Escape");
  await page.keyboard.type(`${HOST}:${REMOTE_PATH}`);
  await expect(remote.locator("mark")).toHaveText([HOST, REMOTE_PATH]);

  await page.keyboard.press("Escape");
  await page.keyboard.type("acme-api");
  await page.keyboard.press("Enter");
  await expect(popup).toBeHidden();
  await expect.poll(() => ipcCalls(page, "window_open_project")).toMatchObject([{ path: "/dev/acme-api" }]);
});
