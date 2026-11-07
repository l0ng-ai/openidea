import { expect, test } from "@playwright/test";

test("a module evaluation failure replaces the splash with copyable details", async ({ page }) => {
  await page.route("**/src/main.tsx", (route) =>
    route.fulfill({ contentType: "text/javascript", body: 'throw new Error("Simulated startup failure");' }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "OpenIDEA could not start" })).toBeVisible();
  await expect(page.locator("#splash")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Startup error details" })).toHaveValue(/Simulated startup failure/);
  await expect(page.getByRole("button", { name: "Copy details" })).toBeFocused();
  await expect(page.getByRole("link", { name: "Report an issue" })).toHaveAttribute("href", /github.com/);
});

test("an unresolved module gets a startup timeout", async ({ page }) => {
  await page.clock.install();
  await page.route("**/src/main.tsx", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "await new Promise(() => {});" }),
  );
  await page.goto("/", { waitUntil: "commit" });
  await page.locator("#splash").waitFor({ state: "attached" });
  await page.clock.runFor(30_000);
  await expect(page.getByRole("textbox", { name: "Startup error details" })).toHaveValue(
    /Startup did not finish within 30 seconds/,
  );
});
