import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("Maven groups environment and runner settings while keeping paths and thread count editable", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  await stubDesktop(page);
  const settingsPath = "C:/Build Config/settings.xml";
  const jdk = "C:/SDKs/jdk-21";
  await page.evaluate(
    ({ settingsPath, jdk }) => {
      window.__ipc.handlers.settings_get_global = () => ({});
      window.__ipc.handlers.settings_get = () => ({});
      window.__ipc.handlers.settings_set = () => ({});
      window.__ipc.handlers.sdk_detect = ({ kind }) =>
        kind === "jdk" ? [{ path: jdk, home: jdk, name: "JDK 21", version: "21", source: "system", extra: null }] : [];
      window.__ipc.handlers["plugin:dialog|open"] = () => settingsPath;
    },
    { settingsPath, jdk },
  );

  await page.keyboard.press("Meta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = settings.getByRole("textbox", { name: "Search settings" });
  await search.fill("thread count");
  await settings.getByRole("treeitem", { name: "Maven", exact: true }).click();
  await search.clear();

  const threads = settings.getByRole("textbox", { name: "Thread count", exact: true });
  const maven = settings.getByRole("button", { name: "Maven home path", exact: true });
  const user = settings.getByRole("textbox", { name: /^User settings file:?$/ });
  const repository = settings.getByRole("textbox", { name: /^Local repository:?$/ });
  const userBrowse = user.locator("..").getByRole("button", { name: /^Browse/ });
  const repoBrowse = repository.locator("..").getByRole("button", { name: /^Browse/ });
  const java = settings.getByRole("button", { name: "JRE", exact: true });
  const download = settings.getByRole("checkbox", { name: "Automatically download sources", exact: true });
  const [count, home] = await Promise.all([threads.boundingBox(), maven.boundingBox()]);
  if (!count || !home) throw new Error("Missing Maven controls");
  expect(count.y).toBeLessThan(home.y);

  const environment = settings.getByRole("region", { name: "Environment", exact: true });
  const importing = settings.getByRole("region", { name: "Importing", exact: true });
  const runner = settings.getByRole("region", { name: "Runner", exact: true });
  await expect(environment.getByRole("button", { name: "Maven home path", exact: true })).toBeVisible();
  await expect(importing.getByRole("checkbox", { name: "Automatically download sources", exact: true })).toBeVisible();
  await expect(runner.getByRole("button", { name: "JRE", exact: true })).toBeVisible();
  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 900 });
    await threads.scrollIntoViewIfNeeded();
    const [threadBox, mavenBox, userBox, userButton, repoBox, repoButton, importBox, javaBox] = await Promise.all(
      [threads, maven, user, userBrowse, repository, repoBrowse, download, java].map((control) =>
        control.boundingBox(),
      ),
    );
    if (!threadBox || !mavenBox || !userBox || !userButton || !repoBox || !repoButton || !importBox || !javaBox)
      throw new Error("Missing Maven layout bounds");
    expect(threadBox.width).toBeLessThan(121);
    expect(mavenBox.x).toBeCloseTo(userBox.x, 0);
    expect(userBox.x).toBeCloseTo(repoBox.x, 0);
    expect(userBox.width).toBeGreaterThan(120);
    expect(userBox.y + userBox.height / 2).toBeCloseTo(userButton.y + userButton.height / 2, 0);
    expect(userButton.x + userButton.width).toBeCloseTo(repoButton.x + repoButton.width, 0);
    expect(repoBox.y + repoBox.height).toBeLessThan(importBox.y);
    expect(importBox.y).toBeLessThan(javaBox.y);
    await expect(userBrowse).toBeInViewport({ ratio: 1 });
  }

  await userBrowse.click();
  await expect(user).toHaveValue(settingsPath);
  await java.click();
  await page.getByRole("option", { name: /JDK 21/ }).click();
  await expect(java).toHaveText("JDK 21");
  await threads.fill("2X");
  await expect(threads).toHaveAttribute("aria-invalid", "true");
  await expect(settings.getByRole("alert")).toContainText("Not a thread count Maven accepts");
  await threads.fill("2.5C");
  await expect(settings.getByRole("alert")).toHaveCount(0);
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await ipcCalls(page, "settings_set")).sort((a, b) => String(a.key).localeCompare(String(b.key))))
    .toEqual([
      { scope: "project", key: "languages.java.maven.runnerJre", value: JSON.stringify(jdk) },
      { scope: "project", key: "languages.java.maven.threads", value: JSON.stringify("2.5C") },
      { scope: "project", key: "languages.java.maven.userSettings", value: JSON.stringify(settingsPath) },
    ]);
});
