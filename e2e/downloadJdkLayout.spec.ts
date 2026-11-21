import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const INSTALL_PATH = `C:/toolchains/${"managed-java-".repeat(16)}jdk`;

test("Download JDK keeps its fields in order and fits long paths in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  await stubDesktop(page);
  await page.evaluate(async (path) => {
    const ipc = window.__ipc;
    ipc.handlers.sdk_detect = () => [];
    ipc.handlers.jdk_download_vendors = () => [
      { id: "temurin", name: "Eclipse Temurin" },
      { id: "microsoft", name: "Microsoft Build of OpenJDK" },
    ];
    ipc.handlers.jdk_download_releases = () => ({ versions: [25, 21, 17], lts: [25, 21, 17], recommended: 25 });
    ipc.handlers.jdk_download_location = () => path;
    ipc.handlers.jdk_download = ({ onEvent }) => {
      ipc.send(onEvent, { type: "progress", fraction: 0.5, message: "Downloaded 50 of 100 MB" });
      return new Promise(() => {});
    };
    ipc.handlers.cancel_request = () => null;
    const actions = "/src/platform/actions.ts";
    await (await import(/* @vite-ignore */ actions)).executeAction("file.projectStructure", "sdks");
  }, INSTALL_PATH);
  await page.getByRole("button", { name: "Add SDK", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download JDK…", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Download JDK", exact: true });
  const version = dialog.getByRole("button", { name: "Version", exact: true });
  const vendor = dialog.getByRole("button", { name: "Vendor", exact: true });
  const location = dialog.getByRole("textbox", { name: "Location:", exact: true });
  await expect(version).toHaveText("25");
  expect((await version.boundingBox())!.y).toBeLessThan((await vendor.boundingBox())!.y);
  expect((await version.boundingBox())!.x).toBeCloseTo((await vendor.boundingBox())!.x, 0);
  expect((await location.boundingBox())!.x).toBeCloseTo((await vendor.boundingBox())!.x, 0);
  await expect(location).toHaveValue(INSTALL_PATH);
  await expect(location).toHaveCSS("font-size", "13px");

  await page.setViewportSize({ width: 400, height: 560 });
  const content = dialog.locator("[data-dialog-body]");
  expect(await content.evaluate((el) => el.scrollWidth)).toBe(await content.evaluate((el) => el.clientWidth));
  const locationLabel = dialog.getByText("Location:", { exact: true });
  expect((await locationLabel.boundingBox())!.y).toBeLessThan((await location.boundingBox())!.y);
  expect((await locationLabel.boundingBox())!.x).toBeCloseTo((await location.boundingBox())!.x, 0);
  await expect(dialog.getByRole("button", { name: "Browse…", exact: true })).toBeInViewport({ ratio: 1 });
  await vendor.click();
  await page.getByRole("option", { name: "Microsoft Build of OpenJDK", exact: true }).click();
  await version.click();
  await page.getByRole("option", { name: /21/ }).click();
  const editedPath = INSTALL_PATH + "-lts";
  await location.fill(editedPath);
  const download = dialog.getByRole("button", { name: "Download", exact: true });
  await download.click();
  await expect(dialog.getByRole("progressbar", { name: "Downloading JDK" })).toHaveAttribute("aria-valuenow", "50");
  await expect(download).toBeDisabled();
  const [request] = await ipcCalls(page, "jdk_download");
  expect(request).toMatchObject({ vendor: "microsoft", version: 21, location: editedPath });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => ipcCalls(page, "cancel_request")).toContainEqual({ id: request!.request });
});
