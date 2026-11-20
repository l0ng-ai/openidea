import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const REPO = "https://example.test/team/billing-service.git";

test("Clone Repository keeps URL, directory, and depth usable when the dialog narrows", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.setViewportSize({ width: 440, height: 620 });
  await page.evaluate(async (repo) => {
    window.__ipc.handlers["plugin:dialog|open"] = () => "/dev/workspaces";
    window.__ipc.handlers.vcs_clone = () => new Promise(() => {});
    const contributionsPath = "/src/workbench/contributions.ts";
    const { registerCloneSource } = await import(/* @vite-ignore */ contributionsPath);
    registerCloneSource({ id: "team", label: "Team repositories", icon: "branch", component: () => null });
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actionsPath);
    await executeAction("vcs.clone", repo);
  }, REPO);

  const dialog = page.getByRole("dialog", { name: "Clone Repository" });
  const sources = dialog.getByRole("complementary", { name: "Clone source" });
  const url = dialog.getByRole("textbox", { name: "URL:" });
  await expect(url).toHaveValue(REPO);
  await expect.poll(async () => (await url.boundingBox())!.width).toBeGreaterThan(180);

  const form = dialog.locator("form");
  const position = () =>
    form.evaluate((el) => {
      const source = el.parentElement!.querySelector("aside")!.getBoundingClientRect();
      const body = el.getBoundingClientRect();
      return { below: body.top >= source.bottom, beside: body.left >= source.right };
    });
  await expect.poll(async () => (await position()).below).toBe(true);
  expect(await form.evaluate((el) => el.scrollWidth === el.clientWidth)).toBe(true);

  await dialog.getByRole("button", { name: "Browse…" }).click();
  const directory = dialog.getByRole("textbox", { name: "Directory:" });
  await expect(directory).toHaveValue("/dev/workspaces/billing-service");

  const shallow = dialog.getByRole("checkbox", { name: /^Shallow clone/ });
  const depth = dialog.getByRole("spinbutton", { name: "Clone depth" });
  await expect(depth).toBeDisabled();
  await shallow.check();
  await depth.fill("0");
  const clone = dialog.getByRole("button", { name: "Clone", exact: true });
  await expect(clone).toBeDisabled();
  await depth.fill("3");

  await page.setViewportSize({ width: 1050, height: 750 });
  await expect.poll(async () => (await position()).beside).toBe(true);
  await sources.getByRole("button", { name: "Team repositories" }).click();
  await expect(url).toBeHidden();
  await sources.getByRole("button", { name: "Repository URL" }).click();
  await expect(url).toHaveValue(REPO);
  await expect(directory).toHaveValue("/dev/workspaces/billing-service");
  await expect(depth).toHaveValue("3");

  await page.setViewportSize({ width: 440, height: 620 });
  await clone.click();
  await expect
    .poll(() => ipcCalls(page, "vcs_clone"))
    .toEqual([expect.objectContaining({ url: REPO, dest: "/dev/workspaces/billing-service", depth: 3 })]);
});
