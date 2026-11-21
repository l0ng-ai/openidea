import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("the Tag form aligns its fields and follows the chosen repository", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const service = `${root}/service`;
    const handlers = window.__ipc.handlers;
    handlers.vcs_tags = ({ repo }) => (repo === service ? ["v1.0"] : []);
    handlers.vcs_create_tag = () => null;
    const store = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ store);
    useVcs.setState({
      root,
      roots: [root, service],
      repo: root,
      available: true,
      heads: {
        [root]: { head: "main", headCommit: "a1234567" },
        [service]: { head: "release", headCommit: "b1234567" },
      },
    });
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("vcs.newTag");
  });

  const dialog = page.getByRole("dialog", { name: "Tag", exact: true });
  const name = dialog.getByRole("textbox", { name: "Tag name:", exact: true });
  const label = dialog.getByText("Tag name:", { exact: true });
  const commit = dialog.getByRole("textbox", { name: "Commit:", exact: true });
  const message = dialog.getByRole("textbox", { name: "Message:", exact: true });
  const create = dialog.getByRole("button", { name: "Create Tag", exact: true });
  await expect(name).toBeFocused();
  const labelBox = (await label.boundingBox())!;
  const fieldBox = (await name.boundingBox())!;
  expect(labelBox.x + labelBox.width).toBeLessThan(fieldBox.x);
  for (const field of [commit, message, dialog.getByRole("checkbox", { name: "Force" })]) {
    expect(Math.abs((await field.boundingBox())!.x - fieldBox.x)).toBeLessThan(1);
  }
  await expect(label).toHaveCSS("font-size", await name.evaluate((el) => getComputedStyle(el).fontSize));
  await expect(label).toHaveCSS("font-family", await name.evaluate((el) => getComputedStyle(el).fontFamily));
  await expect(dialog.getByText("Current branch:", { exact: true })).toBeVisible();
  await expect(dialog.getByText("main", { exact: true })).toBeVisible();

  await name.fill("v1.0");
  await expect(create).toBeEnabled();
  await dialog.getByRole("button", { name: "Repository", exact: true }).click();
  await page.getByRole("option", { name: "service", exact: true }).click();
  await expect(dialog.getByText("release", { exact: true })).toBeVisible();
  await expect(dialog.getByText("main", { exact: true })).toHaveCount(0);
  await expect(name).toHaveAccessibleDescription(/already exists/);
  await expect(create).toBeDisabled();

  await page.setViewportSize({ width: 400, height: 620 });
  const stackedLabel = (await label.boundingBox())!;
  const stackedField = (await name.boundingBox())!;
  expect(stackedLabel.y + stackedLabel.height).toBeLessThanOrEqual(stackedField.y);
  expect(Math.abs(stackedLabel.x - stackedField.x)).toBeLessThan(1);
  await name.fill("v2.0-rc1");
  await commit.fill("HEAD~1");
  await message.fill("Release candidate\nReviewed service changes.");
  await create.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_create_tag"))
    .toEqual([
      {
        repo: "/dev/acme-api/service",
        name: "v2.0-rc1",
        commit: "HEAD~1",
        message: "Release candidate\nReviewed service changes.",
        force: false,
      },
    ]);
});
