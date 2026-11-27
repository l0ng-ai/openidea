import { expect, test } from "./fixtures";

test("configures an Oracle source without a client library", async ({ workbench: page }, info) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const bindingsPath = "/src/bindings.ts";
    const { useDatabase } = await import(storePath);
    const { commands } = await import(bindingsPath);
    commands.dbTest = async (source: unknown) => {
      document.documentElement.dataset.testedSource = JSON.stringify(source);
      return { status: "ok", data: "Oracle Database 23ai Enterprise Edition Release 23.5.0.24.07" };
    };
    useDatabase.setState({ dialog: { kind: "source", source: null } });
  });
  const dialog = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await dialog.getByRole("button", { name: "Data source type", exact: true }).click();
  // The type list is virtualised: reach the entry by typing, then confirm it.
  await page.keyboard.type("oracle");
  await page.keyboard.press("Enter");
  await expect(dialog.locator("#db-port")).toHaveValue("1521");
  await expect(dialog.locator("#db-url")).toHaveValue("jdbc:oracle://localhost:1521");

  // Pure-Rust thin driver: no client library to point at, just the service name.
  const testButton = dialog.getByRole("button", { name: "Test Connection", exact: true });
  await dialog.locator("#db-url").fill("oracle://scott:tiger@db.example:1521/ORCLPDB1");
  await expect(dialog.locator("#db-host")).toHaveValue("db.example");
  await expect(dialog.locator("#db-port")).toHaveValue("1521");
  await expect(dialog.locator("#db-user")).toHaveValue("scott");
  await expect(dialog.locator("#db-database")).toHaveValue("ORCLPDB1");
  await expect(testButton).toBeEnabled();

  await testButton.click();
  await expect(dialog.getByRole("status")).toHaveText(/^Succeeded: Oracle Database 23ai/);
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.testedSource!))).toMatchObject({
    driver: "oracle",
    host: "db.example",
    port: 1521,
    user: "scott",
    database: "ORCLPDB1",
  });
  await dialog.screenshot({ path: info.outputPath("oracle-source.png") });
});
