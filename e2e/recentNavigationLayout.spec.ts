import type { Page } from "@playwright/test";
import { expect, stubDesktop, test } from "./fixtures";

async function openRecent(page: Page, kind: "recentFiles" | "recentLocations") {
  await page.evaluate(async (id) => {
    const actions = "/src/platform/actions.ts";
    void (await import(/* @vite-ignore */ actions)).executeAction(`navigate.${id}`);
  }, kind);
}

test("Recent Files keeps directories beside names and leaves room for files in a narrow window", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.recent_files = () => ["/dev/acme-api/src/orders/InvoiceService.ts"];
  });
  await openRecent(page, "recentFiles");
  const dialog = page.getByRole("dialog", { name: "Recent Files", exact: true });
  const files = dialog.getByRole("listbox", { name: "Recent files" });
  const row = files.getByRole("option").first();
  const name = row.getByText("InvoiceService.ts", { exact: true });
  const directory = row.getByText("src/orders", { exact: true });
  await expect(name).toBeVisible();
  const nameRight = await name.evaluate((el) => el.getBoundingClientRect().right);
  const dirLeft = (await directory.boundingBox())!.x;
  expect(dirLeft - nameRight).toBeLessThanOrEqual(8);

  await page.setViewportSize({ width: 400, height: 500 });
  expect((await files.boundingBox())!.width).toBeGreaterThan(200);
  expect((await dialog.getByRole("textbox", { name: "Filter recent files" }).boundingBox())!.width).toBeGreaterThan(
    200,
  );
  await expect.poll(() => directory.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(20);
  await expect(dialog.getByRole("button", { name: /Recent Locations/ })).toBeVisible();
  const footer = dialog.locator("footer");
  await expect(footer).toBeInViewport({ ratio: 1 });
  expect(
    await dialog.locator("[data-dialog-body]").evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(1);
});

test("Recent Locations keeps all snippet lines visible when the editor font grows", async ({ workbench: page }) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const tracking = "/src/features/search/common/tracking.ts";
    const { useTracking } = await import(/* @vite-ignore */ tracking);
    useTracking.setState({
      locations: [
        {
          path: "/dev/acme-api/src/orders/CalculateOutstandingInvoicesForTheMonthlyReconciliation.ts",
          line: 41,
          col: 4,
          changed: true,
          time: Date.now(),
          snippet: ["const invoices = await repository.openInvoices();", "return sum(invoices);", "}"],
          snippetStart: 40,
        },
      ],
    });
  });
  await openRecent(page, "recentLocations");
  const dialog = page.getByRole("dialog", { name: "Recent Locations", exact: true });
  const row = dialog.getByRole("option").first();
  const code = row.locator("pre");
  await expect(code).toContainText("return sum(invoices);");
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { settings } = useProject.getState();
    useProject.setState({
      settings: {
        ...settings,
        editor: {
          ...settings?.editor,
          fontFamily: "Fira Code",
          fallbackFont: "Maple Mono NF CN",
          fontSize: 19,
          lineHeight: 30,
        },
      },
    });
  });
  await expect(code).toHaveCSS("font-size", "19px");
  await expect(code).toHaveCSS("line-height", "30px");
  await expect(code).toHaveCSS("font-family", /"Fira Code".*"Maple Mono NF CN"/);
  // Three 30px lines; layout may land on a fractional pixel.
  expect((await code.boundingBox())!.height).toBeCloseTo(90, 0);

  await page.setViewportSize({ width: 400, height: 500 });
  const filter = dialog.getByRole("textbox", { name: "Filter recent locations" });
  expect((await filter.boundingBox())!.width).toBeGreaterThan(200);
  await expect(row.getByText("changed", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(filter).toBeFocused();
});
