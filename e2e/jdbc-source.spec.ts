import type { DataSource_Deserialize, DbJdbcDriver } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("configures a local JDBC profile and a source through mocked IPC", async ({ workbench: page }, info) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const drivers: Record<string, unknown>[] = [];
    let sources: Record<string, unknown>[] = [];
    Object.assign(window.__ipc.handlers, {
      db_jdbc_drivers: () => drivers,
      db_jdbc_driver_classes: () => ["org.example.jdbc.Driver"],
      db_save_jdbc_driver: ({ driver }: { driver: Record<string, unknown> }) => {
        const at = drivers.findIndex((d) => d.id === driver.id);
        if (at < 0) drivers.push(driver);
        else drivers[at] = driver;
        return null;
      },
      db_remove_jdbc_driver: ({ id }: { id: string }) => {
        drivers.splice(
          drivers.findIndex((d) => d.id === id),
          1,
        );
        return null;
      },
      file_dialog_needs_gtk: () => false,
      "plugin:dialog|open": () => ["/mock/driver.jar", "/mock/dependency.jar"],
      db_test: () => "Mock JDBC database",
      db_approve_jdbc_source: () => null,
      db_save_sources: ({ sources: value }: { sources: Record<string, unknown>[] }) => {
        sources = value;
        return null;
      },
      db_sources: () => sources,
      db_connected: () => [],
      db_set_password: () => null,
    });
    const storePath = "/src/features/database/store.ts";
    const { openSourceDialog } = await import(/* @vite-ignore */ storePath);
    openSourceDialog(null, {
      driver: "clickhouse",
      name: "Mock connection",
      host: "example.invalid",
      port: 8443,
      ssl: "verifyFull",
      sslCaFile: "/mock/ca.pem",
      sslCertFile: "/mock/client.pem",
      sslKeyFile: "/mock/client.key",
    });
  });
  const source = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await source.getByRole("tab", { name: "SSH/SSL", exact: true }).click();
  await source.screenshot({
    path: info.outputPath("mock-native-clickhouse-before-switch.png"),
    animations: "disabled",
  });
  await source.getByRole("tab", { name: "General", exact: true }).click();
  await source.getByRole("button", { name: "Data source type", exact: true }).click();
  await page.getByRole("option", { name: "Custom JDBC", exact: true }).click();
  await expect(source.getByRole("tab", { name: "SSH/SSL", exact: true })).toHaveCount(0);
  await expect(source.locator("#db-url")).toHaveValue("");
  await source.getByRole("button", { name: "Manage Drivers…", exact: true }).click();
  const profiles = page.getByRole("dialog", { name: "JDBC Driver Profiles", exact: true });
  await profiles.getByRole("button", { name: "Add…", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add JDBC Driver", exact: true });
  await editor.getByLabel("Name:", { exact: true }).fill("Example local driver");
  await editor.getByRole("button", { name: "Add JARs…", exact: true }).click();
  await expect(editor.getByText("dependency.jar", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Driver class:", { exact: true })).toHaveValue("org.example.jdbc.Driver");
  await editor.getByLabel("URL template:", { exact: true }).fill("jdbc:example://{host}/{database}");
  await editor.screenshot({ path: info.outputPath("jdbc-profile-editor.png"), animations: "disabled" });
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const trust = page.getByRole("dialog", { name: "Trust JDBC Driver?", exact: true });
  await expect(trust).toContainText("execute local code with your user permissions");
  expect(await ipcCalls(page, "db_save_jdbc_driver")).toHaveLength(0);
  await trust.screenshot({ path: info.outputPath("mock-jdbc-driver-trust.png"), animations: "disabled" });
  await trust.getByRole("button", { name: "Trust and Save", exact: true }).click();
  await profiles.getByRole("button", { name: "Use Driver", exact: true }).click();
  await expect(source.getByRole("button", { name: "JDBC driver profile", exact: true })).toHaveText(
    "Example local driver",
  );
  await source.getByLabel("Host:", { exact: true }).fill("example.invalid");
  await source.getByLabel("Database:", { exact: true }).fill("catalog");
  await expect(source.locator("#db-url")).toHaveValue("jdbc:example://example.invalid/catalog");
  await source.screenshot({ path: info.outputPath("jdbc-template.png"), animations: "disabled" });
  const url = "jdbc:example://example.invalid/catalog?ssl=true";
  await source.locator("#db-url").fill(url);
  const test = source.getByRole("button", { name: "Test Connection", exact: true });
  await expect(test).toBeDisabled();
  await source.getByRole("checkbox", { name: "I have configured JDBC connection security.", exact: true }).check();
  await source.locator("#db-user").fill("example-user");
  await source.locator("#db-password").fill("mock secret");
  await source.screenshot({ path: info.outputPath("mock-jdbc-source-after-switch.png"), animations: "disabled" });
  await source.getByRole("tab", { name: "Options", exact: true }).click();
  await expect(source.getByRole("button", { name: "Transaction control", exact: true })).toHaveCount(0);
  await source.getByRole("checkbox", { name: "Read-only", exact: true }).check();
  await expect(
    source.getByText("For read-only access, use a database account with read-only privileges."),
  ).toBeVisible();
  await source.screenshot({ path: info.outputPath("jdbc-read-only.png"), animations: "disabled" });
  await source.getByRole("tab", { name: "Advanced", exact: true }).click();
  await source.getByRole("button", { name: "Add Property", exact: true }).click();
  await source.getByLabel("Property name", { exact: true }).fill("ssl");
  await source.getByLabel("Property value", { exact: true }).fill("true");
  await test.click();
  await expect(source.getByRole("status")).toHaveText("Succeeded: Mock JDBC database");
  const [tested] = await ipcCalls(page, "db_test");
  expect(tested).toMatchObject({
    password: "mock secret",
    source: {
      driver: "jdbc",
      url,
      user: "example-user",
      readOnly: true,
      properties: [{ name: "ssl", value: "true" }],
    },
  });
  await source.getByRole("button", { name: "OK", exact: true }).click();
  await expect(source).not.toBeVisible();
  const [save] = await ipcCalls(page, "db_save_sources");
  const saved = (save?.sources as DataSource_Deserialize[] | undefined)?.[0];
  const [profile] = await ipcCalls(page, "db_save_jdbc_driver");
  const driver = profile?.driver as DbJdbcDriver | undefined;
  if (!saved || !driver) throw new Error("Expected the JDBC source and driver to be saved");
  expect(saved.readOnly).toBe(true);
  expect(saved.jdbcDriver).toBe(driver.id);
  for (const key of ["jars", "className", "classpath", "exec", "password"]) expect(saved).not.toHaveProperty(key);
});
