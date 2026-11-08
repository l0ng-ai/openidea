import { expect, test } from "./fixtures";

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
