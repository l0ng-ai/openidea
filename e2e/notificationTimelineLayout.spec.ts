import { expect, test } from "./fixtures";

test("keeps the Notifications timeline controls visible while long entries scroll", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.evaluate(async () => {
    const servicePath = "/src/workbench/contributions.ts";
    const { notifications } = await import(/* @vite-ignore */ servicePath);
    const notify = notifications().notify;
    notify({
      level: "warning",
      title: "Workspace import warnings",
      body: Array.from({ length: 28 }, (_, i) => `Build step ${i + 1} reported a warning`).join("\n"),
    });
    notify({
      level: "error",
      title: "Build failed for the settlement service",
      body: "The compiler failed while checking settlement.ts.",
      actions: [
        {
          label: "Open build output",
          run: () => document.body.setAttribute("data-output-opened", "true"),
        },
      ],
    });
  });
  await page.getByRole("button", { name: "Notifications", exact: true }).click();

  const panel = page.getByRole("region", { name: "Notifications", exact: true });
  const timeline = panel.getByRole("list", { name: "Timeline" });
  const clear = panel.getByRole("button", { name: "Clear All", exact: true });
  const entries = timeline.getByRole("listitem");
  const build = entries.first();
  const warnings = entries.nth(1);
  await expect(build).toContainText("Build failed for the settlement service");
  await expect(warnings).toContainText("Workspace import warnings");
  await expect(build.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d\d-\d\dT/);
  const [title, time, dismiss] = await Promise.all([
    build.getByText("Build failed for the settlement service").boundingBox(),
    build.locator("time").boundingBox(),
    build.getByRole("button", { name: "Dismiss" }).boundingBox(),
  ]);
  expect(time!.x).toBeGreaterThanOrEqual(title!.x + title!.width);
  expect(dismiss!.x).toBeGreaterThan(time!.x + time!.width);

  await page.setViewportSize({ width: 590, height: 478 });
  const [narrowTitle, narrowTime, narrowDismiss] = await Promise.all([
    build.getByText("Build failed for the settlement service").boundingBox(),
    build.locator("time").boundingBox(),
    build.getByRole("button", { name: "Dismiss" }).boundingBox(),
  ]);
  expect(narrowTitle!.width).toBeGreaterThan(75);
  expect(narrowTime!.y).toBeGreaterThanOrEqual(narrowTitle!.y + narrowTitle!.height);
  expect(narrowDismiss!.x).toBeGreaterThan(narrowTime!.x + narrowTime!.width);

  await build.getByRole("button", { name: "Open build output" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-output-opened", "true");
  await build.getByRole("button", { name: "Dismiss" }).click();
  await expect(build).toContainText("Workspace import warnings");
  const body = build.getByText("Build step 1 reported a warning", { exact: false });
  expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  const scrollTop = await timeline.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    return list.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(0);
  await expect(clear).toBeInViewport({ ratio: 1 });
  expect(await timeline.evaluate((list) => list.scrollWidth - list.clientWidth)).toBe(0);
  await clear.click();
  await expect(panel.getByText("No notifications", { exact: true })).toBeVisible();
});
