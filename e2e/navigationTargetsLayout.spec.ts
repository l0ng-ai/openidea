import { expect, test } from "./fixtures";

test("keeps names, containers and keyboard targets visible near the window edge", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 460, height: 320 });
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const navigationPath = "/src/editor/lsp/navigation.ts";
    const popupPath = "/src/editor/lsp/popupStore.ts";
    const { docBackend } = await import(/* @vite-ignore */ backendPath);
    const { locationItems } = await import(/* @vite-ignore */ navigationPath);
    const { openPopup } = await import(/* @vite-ignore */ popupPath);
    const targets = Array.from({ length: 20 }, (_, i) => {
      const path = `/dev/acme-api/src/main/customer/orders/processing/notification/delivery/provider-${i + 1}/Target${i + 1}.txt`;
      const name = i === 0 ? "dispatchOrder" : `dispatchOrder${i + 1}`;
      docBackend().files.set(path, `${name} target\n`);
      return {
        path,
        name,
        kind: "method",
        container: "OrderService",
        uri: null,
        range: {
          start: { line: 0, col: 0 },
          end: { line: 0, col: name.length },
        },
      };
    });
    openPopup({
      kind: "list",
      anchor: { x: 50, y: 150 },
      title: "Choose Declaration (20 found)",
      items: await locationItems(targets),
    });
  });

  const popup = page.getByRole("dialog", { name: "Choose Declaration (20 found)" });
  const list = popup.getByRole("listbox");
  const first = list.getByRole("option", { selected: true });
  const name = first.getByText("dispatchOrder", { exact: true });
  const container = first.getByText("(OrderService)", { exact: true });
  const path = first.getByText(/provider-1\/Target1\.txt:1$/);
  await expect(container).toBeInViewport({ ratio: 1 });
  await expect(container).toHaveCSS("font-size", await name.evaluate((el) => getComputedStyle(el).fontSize));
  const nameBox = (await name.boundingBox())!;
  const containerBox = (await container.boundingBox())!;
  const pathBox = (await path.locator("..").boundingBox())!;
  expect(containerBox.x - nameBox.x - nameBox.width).toBeLessThanOrEqual(4);
  expect(pathBox.x).toBeGreaterThan(containerBox.x);

  await list.press("End");
  await expect(list.getByRole("option", { name: /dispatchOrder20/, selected: true })).toBeInViewport({ ratio: 1 });
  await list.press("Enter");
  await expect(popup).toBeHidden();
  await expect(page.getByRole("tab", { name: "Target20.txt", exact: true, selected: true })).toBeVisible();
});
