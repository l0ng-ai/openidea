import { expect, stubDesktop, test } from "./fixtures";

test("the environment editor resizes both tables and focuses a new variable", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const path = "/src/features/run/store.ts";
    const { useRun } = await import(/* @vite-ignore */ path);
    window.__ipc.handlers.run_system_env = () =>
      Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`SYSTEM_${i + 1}`, `example-${i + 1}`]));
    useRun.setState({
      configs: [
        {
          id: "layout:env",
          kind: "shell",
          name: "Environment example",
          command: "npm",
          args: ["start"],
          env: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`APP_${i + 1}`, `value-${i + 1}`])),
          detected: false,
          isTest: false,
          debugAdapter: null,
        },
      ],
      selectedId: "layout:env",
      loaded: true,
      editorOpen: true,
    });
  });
  const configurations = page.getByRole("dialog", { name: "Run/Debug Configurations", exact: true });
  const edit = configurations.getByRole("button", { name: "Edit Environment Variables" });
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "Environment Variables", exact: true });
  const user = dialog.getByRole("table", { name: "User environment variables" });
  const system = dialog.getByRole("table", { name: "System environment variables" });
  await expect(system.getByRole("row")).toHaveCount(29);

  const userHeight = (await user.boundingBox())!.height;
  const systemHeight = (await system.boundingBox())!.height;
  const handle = dialog.getByRole("separator", { name: "Resize" });
  await expect(handle).toBeVisible();
  const { x, y } = (await handle.boundingBox())!;
  await page.mouse.move(x + 5, y + 5);
  await page.mouse.down();
  await page.mouse.move(x + 5, y + 101, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await user.boundingBox())!.height).toBeGreaterThan(userHeight + 30);
  await expect.poll(async () => (await system.boundingBox())!.height).toBeGreaterThan(systemHeight + 30);

  await system.evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect(await system.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await user.evaluate((el) => el.scrollTop)).toBe(0);
  const columnHeader = (await system.getByRole("columnheader", { name: "Name" }).boundingBox())!;
  expect(columnHeader.y).toBeGreaterThanOrEqual((await system.boundingBox())!.y);
  expect(columnHeader.y).toBeLessThan((await system.boundingBox())!.y + columnHeader.height);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 430, height: 530 });
  await edit.click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  const name = user.getByRole("textbox", { name: "Variable 19 name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  expect(await user.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await name.fill("APP_1");
  await expect(dialog.getByRole("alert")).toHaveText("Duplicate environment variable: APP_1");
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  await expect(ok).toBeDisabled();
  await expect(ok).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 });
  await name.fill("LOG_LEVEL");
  await user.getByRole("textbox", { name: "Variable 19 value", exact: true }).fill("debug");
  await dialog.getByRole("checkbox", { name: "Include system environment variables" }).uncheck();
  await ok.click();
  await expect(configurations.getByRole("textbox", { name: "Environment variables", exact: true })).toHaveValue(
    /LOG_LEVEL=debug/,
  );
  await edit.click();
  await expect(dialog.getByRole("checkbox", { name: "Include system environment variables" })).not.toBeChecked();
});
