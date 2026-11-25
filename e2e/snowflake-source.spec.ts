import { expect, test } from "./fixtures";

test("configures a Snowflake source with key-pair authentication", async ({ workbench: page }, info) => {
  await page.evaluate(async () => {
    const storePath = "/src/features/database/store.ts";
    const bindingsPath = "/src/bindings.ts";
    const { useDatabase } = await import(storePath);
    const { commands } = await import(bindingsPath);
    commands.dbTest = async (source: unknown, password: unknown) => {
      document.documentElement.dataset.testedSource = JSON.stringify(source);
      document.documentElement.dataset.testedSecret = JSON.stringify(password);
      return { status: "ok", data: "Snowflake 10.0.0" };
    };
    useDatabase.setState({ dialog: { kind: "source", source: null } });
  });
  const dialog = page.getByRole("dialog", { name: "New Data Source", exact: true });
  await dialog.getByRole("button", { name: "Data source type", exact: true }).click();
  // The type list is virtualised: reach the entry by typing, then confirm it.
  await page.keyboard.type("snowflake");
  await page.keyboard.press("Enter");

  // The account has no default, an HTTPS driver has no SSH tunnel, and a key pair is the default method.
  const testButton = dialog.getByRole("button", { name: "Test Connection", exact: true });
  await expect(dialog.getByText("Account:", { exact: true })).toBeVisible();
  await expect(dialog.locator("#db-host")).toHaveValue("");
  await expect(dialog.locator("#db-port")).toHaveAttribute("placeholder", "443");
  await expect(dialog.getByRole("tab", { name: "SSH/SSL", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Snowflake authentication", exact: true })).toHaveText("Key pair");
  await expect(dialog.getByText("Passphrase:", { exact: true })).toBeVisible();
  await expect(testButton).toBeDisabled();

  await dialog.locator("#db-host").fill("myorg-myaccount");
  await dialog.locator("#db-user").fill("jane");
  await expect(testButton).toBeDisabled();
  await dialog.locator("#db-snowflake-key").fill("~/.ssh/rsa_key.p8");
  await expect(testButton).toBeEnabled();
  await dialog.locator("#db-password").fill("key passphrase");
  await dialog.locator("#db-database").fill("ANALYTICS");
  await dialog.locator("#db-snowflake-schema").fill("PUBLIC");
  await dialog.locator("#db-snowflake-warehouse").fill("COMPUTE_WH");
  await dialog.locator("#db-snowflake-role").fill("ANALYST");
  await expect(dialog.locator("#db-url")).toHaveValue(
    "jdbc:snowflake://myorg-myaccount.snowflakecomputing.com/?db=ANALYTICS&schema=PUBLIC&warehouse=COMPUTE_WH&role=ANALYST",
  );
  await dialog.screenshot({ path: info.outputPath("snowflake-source-key-pair.png") });

  await testButton.click();
  await expect(dialog.getByRole("status")).toHaveText("Succeeded: Snowflake 10.0.0");
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.testedSource!))).toMatchObject({
    driver: "snowflake",
    host: "myorg-myaccount",
    user: "jane",
    database: "ANALYTICS",
    options: { defaultSchema: "PUBLIC" },
    snowflake: { warehouse: "COMPUTE_WH", role: "ANALYST", auth: "keyPair", privateKeyFile: "~/.ssh/rsa_key.p8" },
  });
  expect(await page.evaluate(() => JSON.parse(document.documentElement.dataset.testedSecret!))).toBe("key passphrase");

  // Other methods keep the one secret field and name what it holds.
  await dialog.getByRole("button", { name: "Snowflake authentication", exact: true }).click();
  await page.getByRole("option", { name: "Programmatic access token", exact: true }).click();
  await expect(dialog.locator("#db-snowflake-key")).toHaveCount(0);
  await expect(dialog.getByText("Token:", { exact: true })).toBeVisible();
  await expect(dialog.locator("#db-password")).toHaveAttribute("type", "password");
  await dialog.screenshot({ path: info.outputPath("snowflake-source-token.png") });

  // Browser sign-in has nothing to type: the secret field goes away.
  await dialog.getByRole("button", { name: "Snowflake authentication", exact: true }).click();
  await page.getByRole("option", { name: "Single sign-on (web browser)", exact: true }).click();
  await expect(dialog.locator("#db-password")).toBeHidden();
  await expect(dialog.getByText("Opens your web browser to sign in", { exact: false })).toBeVisible();
  await expect(testButton).toBeEnabled();
  await dialog.screenshot({ path: info.outputPath("snowflake-source-browser.png") });

  // A pasted JDBC URL fills the settings it names.
  await dialog
    .locator("#db-url")
    .fill(
      "jdbc:snowflake://xy12345.eu-central-1.snowflakecomputing.com/?db=RAW&warehouse=LOAD_WH&role=LOADER&schema=STAGE",
    );
  await expect(dialog.locator("#db-host")).toHaveValue("xy12345.eu-central-1.snowflakecomputing.com");
  await expect(dialog.locator("#db-database")).toHaveValue("RAW");
  await expect(dialog.locator("#db-snowflake-schema")).toHaveValue("STAGE");
  await expect(dialog.locator("#db-snowflake-warehouse")).toHaveValue("LOAD_WH");
  await expect(dialog.locator("#db-snowflake-role")).toHaveValue("LOADER");
});
