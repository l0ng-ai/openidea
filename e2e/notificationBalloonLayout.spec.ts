import { expect, test } from "./fixtures";

test("fits notification body and actions below the dismiss button in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 420, height: 540 });
  const title = "Validation failed for the catalog service";
  const body = "The build stopped while checking the catalog response type.";
  const action = "recheckCatalogServiceResponsePayloadAfterRegeneratingTypesForDevelopment";
  await page.evaluate(
    async ({ title, body, action }) => {
      const servicePath = "/src/workbench/contributions.ts";
      const { notifications } = await import(/* @vite-ignore */ servicePath);
      notifications().notify({
        level: "error",
        title,
        body,
        actions: [{ label: action, run: () => document.body.setAttribute("data-validation-retried", "true") }],
      });
    },
    { title, body, action },
  );

  const balloon = page.getByRole("alert").filter({ hasText: title });
  const message = balloon.getByText(body, { exact: true });
  const dismiss = balloon.getByRole("button", { name: "Dismiss", exact: true });
  const retry = balloon.getByRole("button", { name: action, exact: true });
  await expect(balloon).toBeInViewport({ ratio: 1 });
  const [messageBox, dismissBox] = await Promise.all([message.boundingBox(), dismiss.boundingBox()]);
  expect(messageBox!.y).toBeGreaterThanOrEqual(dismissBox!.y + dismissBox!.height);
  expect(messageBox!.x + messageBox!.width).toBeGreaterThanOrEqual(dismissBox!.x + dismissBox!.width - 1);
  expect(await retry.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await retry.click();
  await expect(page.locator("body")).toHaveAttribute("data-validation-retried", "true");
  await expect(balloon).toBeHidden();
});
