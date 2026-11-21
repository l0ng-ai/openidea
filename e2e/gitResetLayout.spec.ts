import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const root = "/dev/acme-api";
const service = `${root}/service`;
const target = "123456789abcdef123456789abcdef123456789a";

test.beforeEach(async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(
    ({ root, service }) => {
      const heads = {
        [root]: { head: "main", headCommit: "a1234567" },
        [service]: { head: "release", headCommit: "b1234567" },
      };
      const handlers = window.__ipc.handlers;
      handlers.vcs_operation = () => null;
      handlers.vcs_roots = () => Object.entries(heads).map(([root, head]) => ({ root, ...head, operation: null }));
      handlers.vcs_branch_info = ({ repo }) => ({
        ...heads[typeof repo === "string" ? repo : root],
        upstream: null,
        ahead: 0,
        behind: 0,
        operation: null,
      });
      handlers.vcs_status = () => [];
      handlers.vcs_branches = () => [];
      const store = "/src/features/vcs/store.ts";
      const context = "/src/platform/context.ts";
      return Promise.all([import(/* @vite-ignore */ store), import(/* @vite-ignore */ context)]).then(
        ([{ useVcs }, { setContext }]) => {
          useVcs.setState({
            root,
            roots: [root, service],
            repo: root,
            available: true,
            heads,
          });
          setContext("vcsAvailable", true);
        },
      );
    },
    { root, service },
  );
});

test("Reset HEAD aligns its fields and applies the chosen mode to the selected repository", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.resetHead");
  });
  const dialog = page.getByRole("dialog", { name: "Git Reset", exact: true });
  const label = dialog.getByText("To commit:", { exact: true });
  const commit = dialog.getByRole("textbox", { name: "To commit:", exact: true });
  await expect(commit).toBeFocused();
  const labelBox = (await label.boundingBox())!;
  const commitBox = (await commit.boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThan(commitBox.x);
  await expect(label).toHaveCSS("font-size", await commit.evaluate((el) => getComputedStyle(el).fontSize));
  await expect(dialog.getByText("main", { exact: true })).toBeVisible();
  const resetType = dialog.getByRole("button", { name: "Reset type", exact: true });
  await expect(resetType).toHaveText("Mixed");
  const typeLabelBox = (await dialog.getByText("Reset type:", { exact: true }).boundingBox())!;
  const typePickerBox = (await resetType.boundingBox())!;
  expect(
    Math.abs(typeLabelBox.y + typeLabelBox.height / 2 - (typePickerBox.y + typePickerBox.height / 2)),
  ).toBeLessThan(1);

  await commit.fill("feature/api");
  await dialog.getByRole("button", { name: "Repository", exact: true }).click();
  await page.getByRole("option", { name: "service", exact: true }).click();
  await expect(dialog.getByText("release", { exact: true })).toBeVisible();
  await expect(commit).toHaveValue("HEAD");
  await resetType.click();
  await page.getByRole("option", { name: "Soft", exact: true }).click();
  await expect(dialog.getByText("Files won't change, differences will be staged for commit.")).toBeVisible();

  await page.setViewportSize({ width: 400, height: 620 });
  const narrowLabel = (await label.boundingBox())!;
  const narrowCommit = (await commit.boundingBox())!;
  expect(narrowLabel.y + narrowLabel.height).toBeLessThan(narrowCommit.y);
  expect(Math.abs(narrowLabel.x - narrowCommit.x)).toBeLessThan(1);
  await commit.fill("HEAD~1");
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([{ repo: service, op: { op: "reset", mode: "soft", commit: "HEAD~1" } }]);
});

test("Reset to Here shows the pinned repository, branch, and commit above the modes", async ({ workbench: page }) => {
  await page.evaluate(
    async ({ service, target }) => {
      const actions = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction("vcs.log.resetToHere", {
        repo: service,
        id: target,
        author: "Casey Review",
        summary: "Review service totals",
      });
    },
    { service, target },
  );
  const dialog = page.getByRole("dialog", { name: "Git Reset", exact: true });
  await expect(dialog.getByText("service", { exact: true })).toBeVisible();
  await expect(dialog.getByText("release", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Review service totals", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  const modes = dialog.getByRole("radiogroup", { name: "Reset type" });
  await expect(modes.getByRole("radio", { name: /^Mixed/ })).toBeChecked();
  await modes.getByRole("radio", { name: /^Keep/ }).check();
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect
    .poll(() => ipcCalls(page, "vcs_operation"))
    .toMatchObject([{ repo: service, op: { op: "reset", mode: "keep", commit: target } }]);
});
