import { expect, test } from "./fixtures";

test("configures a ClickHouse HTTP source and keeps transaction controls unavailable", async ({
  workbench: page,
}, info) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const bindingsPath = "/src/bindings.ts";
    const { useDatabase } = await import(storePath);
    const { commands } = await import(bindingsPath);
    commands.dbTest = async (source: unknown) => {
      document.documentElement.dataset.testedSource = JSON.stringify(source);
      return { status: "ok", data: "ClickHouse" };
    };
    useDatabase.setState({ dialog: { kind: "source", source: null } });
  });
  const dialog = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await dialog.getByRole("button", { name: "Data source type", exact: true }).click();
  await page.getByRole("option", { name: "ClickHouse", exact: true }).click();
  await expect(dialog.locator("#db-port")).toHaveValue("8123");
  await expect(dialog.locator("#db-user")).toHaveValue("default");
  await expect(dialog.locator("#db-database")).toHaveValue("default");
  await expect(dialog.locator("#db-url")).toHaveValue("http://localhost:8123/default");
  await dialog.locator("#db-url").fill("https://reader@db.example:8443/analytics");
  await expect(dialog.locator("#db-host")).toHaveValue("db.example");
  await expect(dialog.locator("#db-port")).toHaveValue("8443");
  await expect(dialog.locator("#db-user")).toHaveValue("reader");
  await expect(dialog.locator("#db-database")).toHaveValue("analytics");
  await dialog.getByRole("tab", { name: "Advanced", exact: true }).click();
  await expect(dialog.locator('#db-property-names option[value="http_read_timeout"]')).toHaveCount(1);
  await dialog.getByRole("button", { name: "Add Property", exact: true }).click();
  await dialog.getByLabel("Property name").fill("http_read_timeout");
  await dialog.getByLabel("Property value").fill("900");
  await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Succeeded: ClickHouse");
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.testedSource!))).toMatchObject({
    driver: "clickhouse",
    host: "db.example",
    port: 8443,
    user: "reader",
    database: "analytics",
    ssl: "verifyFull",
    properties: [{ name: "http_read_timeout", value: "900" }],
  });
  await dialog.screenshot({ path: info.outputPath("clickhouse-source.png") });
  await dialog.getByRole("tab", { name: "Options", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Transaction control", exact: true })).toBeDisabled();
});
