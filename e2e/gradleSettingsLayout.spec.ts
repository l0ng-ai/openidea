import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Gradle keeps the local installation with Distribution and saves edits in project scope", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await stubDesktop(page);
  const gradleHome = "C:/Tools/Gradle 8.14";
  await page.evaluate((path) => {
    window.__ipc.handlers.settings_get_global = () => ({});
    window.__ipc.handlers.settings_get = () => ({});
    window.__ipc.handlers.settings_set = () => ({});
    window.__ipc.handlers.sdk_detect = () => [];
    window.__ipc.handlers["plugin:dialog|open"] = () => path;
  }, gradleHome);

  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("Gradle JVM");
  await settings.getByRole("treeitem", { name: "Gradle", exact: true }).click();
  await search.clear();

  const userHome = settings.getByRole("textbox", { name: /^Gradle user home:?$/ });
  const runUsing = settings.getByRole("button", { name: "Build and run using", exact: true });
  const distribution = settings.getByRole("button", { name: "Distribution", exact: true });
  const jvm = settings.getByRole("button", { name: "Gradle JVM", exact: true });
  const installation = settings.getByRole("textbox", { name: "Gradle home", exact: true });
  const [user, run, distro, sdk] = await Promise.all(
    [userHome, runUsing, distribution, jvm].map((el) => el.boundingBox()),
  );
  if (!user || !run || !distro || !sdk) throw new Error("Missing Gradle settings fields");
  expect(user.y).toBeLessThan(run.y);
  expect(run.y).toBeLessThan(distro.y);
  expect(distro.y).toBeLessThan(sdk.y);
  await expect(
    settings
      .getByRole("region", { name: "Build and Run", exact: true })
      .getByRole("button", { name: "Build and run using" }),
  ).toBeVisible();
  const runtime = settings.getByRole("region", { name: "Gradle runtime", exact: true });
  await expect(runtime.getByRole("button", { name: "Distribution", exact: true })).toBeVisible();
  await expect(runtime.getByRole("button", { name: "Gradle JVM", exact: true })).toBeVisible();

  await expect(distribution).toHaveText("Gradle wrapper");
  await expect(installation).toHaveCount(0);
  await distribution.click();
  await page.getByRole("option", { name: "Local installation", exact: true }).click();
  const browse = installation.locator("..").getByRole("button", { name: /^Browse/ });

  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(browse).toBeInViewport({ ratio: 1 });
    const [choice, path, button, java] = await Promise.all(
      [distribution, installation, browse, jvm].map((el) => el.boundingBox()),
    );
    if (!choice || !path || !button || !java) throw new Error("Missing local installation controls");
    expect(path.width).toBeGreaterThan(120);
    expect(path.y + path.height / 2).toBeCloseTo(button.y + button.height / 2, 0);
    expect(path.y + path.height).toBeLessThan(java.y);
    if (width === 1120) {
      expect(path.x).toBeGreaterThan(choice.x + choice.width);
      expect(path.y).toBeCloseTo(choice.y, 0);
    } else {
      expect(path.x).toBeCloseTo(choice.x, 0);
      expect(path.y).toBeGreaterThan(choice.y + choice.height);
    }
  }

  await browse.click();
  await expect(installation).toHaveValue(gradleHome);
  await userHome.fill("C:/Build Cache/Gradle");
  await distribution.click();
  await page.getByRole("option", { name: "Gradle wrapper", exact: true }).click();
  await expect(installation).toHaveCount(0);
  await distribution.click();
  await page.getByRole("option", { name: "Local installation", exact: true }).click();
  await expect(installation).toHaveValue(gradleHome);
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await ipcCalls(page, "settings_set")).sort((a, b) => String(a.key).localeCompare(String(b.key))))
    .toEqual([
      { scope: "project", key: "languages.java.gradle.distribution", value: JSON.stringify("local") },
      { scope: "project", key: "languages.java.gradle.home", value: JSON.stringify(gradleHome) },
      { scope: "project", key: "languages.java.gradle.userHome", value: JSON.stringify("C:/Build Cache/Gradle") },
    ]);
});
