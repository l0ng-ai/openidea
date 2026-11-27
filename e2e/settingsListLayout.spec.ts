import { expect, test } from "./fixtures";

test("External Tools pairs metadata and separates command fields from advanced options", async ({
  workbench: page,
}) => {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  const openPage = async () => {
    await search.fill("External Tools");
    await dialog.getByRole("treeitem", { name: "External Tools", exact: true }).click();
    await search.clear();
  };
  await openPage();
  await dialog.getByRole("toolbar", { name: "External tools actions" }).getByRole("button", { name: "Add" }).click();
  const name = dialog.getByRole("textbox", { name: /^Name/ });
  const group = dialog.getByRole("textbox", { name: /^Group/ });
  const description = dialog.getByRole("textbox", { name: /^Description/ });
  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(async () => {
      const [nameBox, groupBox, descriptionBox] = await Promise.all(
        [name, group, description].map((field) => field.boundingBox()),
      );
      if (width === 1120) {
        expect(groupBox!.y).toBe(nameBox!.y);
        expect(groupBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width);
      } else {
        expect(groupBox!.y).toBeGreaterThan(nameBox!.y);
      }
      expect(descriptionBox!.x).toBe(nameBox!.x);
      expect(descriptionBox!.y).toBeGreaterThan(groupBox!.y);
    }).toPass({ timeout: 3000 });
  }
  const command = dialog.getByRole("region", { name: "Tool Settings", exact: true });
  await expect(command.getByRole("textbox", { name: /^Program/ })).toBeVisible();
  await expect(command.getByRole("textbox", { name: /^Arguments/ })).toBeVisible();
  await expect(command.getByRole("textbox", { name: /^Working directory/ })).toBeVisible();
  const sync = dialog.getByRole("checkbox", { name: "Synchronize files after execution" });
  await expect(sync).toBeHidden();
  await search.fill("Synchronize files after execution");
  await expect(sync).toBeVisible();
  await search.clear();
  await expect(sync).toBeHidden();
  await dialog.getByText("Advanced options", { exact: true }).click();
  await name.fill("Validate project");
  await sync.setChecked(!(await sync.isChecked()));
  const enabled = await sync.isChecked();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await page.keyboard.press("Meta+,");
  await openPage();
  await expect(name).toHaveValue("Validate project");
  await dialog.getByText("Advanced options", { exact: true }).click();
  await expect(sync).toBeChecked({ checked: enabled });
});

for (const kind of ["external", "ssh", "target"] as const) {
  test(`${kind} settings keep long names and details inside their selection row`, async ({ workbench: page }) => {
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
    await page.evaluate(async (kind) => {
      const path = "/src/features/settings/model/staging.ts";
      const { selectPage, stage } = await import(/* @vite-ignore */ path);
      const remotePath = "/src/platform/remoteSettings.ts";
      const workflowPath = "/src/platform/workflowSettings.ts";
      const { DEFAULT_SSH_CONFIG, DEFAULT_RUN_TARGET } = await import(/* @vite-ignore */ remotePath);
      const { DEFAULT_EXTERNAL_TOOL } = await import(/* @vite-ignore */ workflowPath);
      const name = "Run integration tests for the current project with the configured environment";
      const detail = "Shared infrastructure for the staging environment";
      if (kind === "external") {
        stage("tools.externalTools", "global", "externalTools", [
          { ...DEFAULT_EXTERNAL_TOOL, id: "qa", name, group: detail },
        ]);
        selectPage("tools.externalTools");
      } else if (kind === "ssh") {
        stage("tools.sshConfigurations", "global", "ssh.configs", [
          { ...DEFAULT_SSH_CONFIG, id: "qa", name, host: detail, user: "qa" },
        ]);
        selectPage("tools.sshConfigurations");
      } else {
        stage("build.runTargets", "global", "runTargets", [
          { ...DEFAULT_RUN_TARGET, id: "qa", name, kind: "docker", image: detail },
        ]);
        selectPage("build.runTargets");
      }
    }, kind);
    const row = page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("option").first();
    await expect(row).toBeVisible();
    for (const width of [1000, 640, 520]) {
      await page.setViewportSize({ width, height: 760 });
      const fits = await row.evaluate((row) => {
        const box = row.getBoundingClientRect();
        return [...row.querySelectorAll(":scope > span")].every((span) => {
          const range = document.createRange();
          range.selectNodeContents(span);
          return [...range.getClientRects()].every((r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1);
        });
      });
      expect(fits).toBe(true);
    }
    await expect(row.locator(":scope > span").first()).toHaveAttribute(
      "title",
      "Run integration tests for the current project with the configured environment",
    );
    await page.evaluate(async (kind) => {
      const path = "/src/features/settings/model/staging.ts";
      const { stage } = await import(/* @vite-ignore */ path);
      const [id, key] =
        kind === "external"
          ? ["tools.externalTools", "externalTools"]
          : kind === "ssh"
            ? ["tools.sshConfigurations", "ssh.configs"]
            : ["build.runTargets", "runTargets"];
      stage(id, "global", key, []);
    }, kind);
    const empty = page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("listbox");
    await expect(row).toHaveCount(0);
    const hintFits = await empty.evaluate((list) => {
      const hint = list.firstElementChild!;
      const box = hint.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(hint);
      return [...range.getClientRects()].every((r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1);
    });
    expect(hintFits).toBe(true);
  });
}
