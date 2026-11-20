import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function openProxySettings(page: Page) {
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const search = dialog.getByRole("textbox", { name: "Search settings" });
  await search.fill("HTTP Proxy");
  await dialog.getByRole("treeitem", { name: "HTTP Proxy", exact: true }).click();
  await search.clear();
  return dialog;
}

test("HTTP Proxy keeps server and authentication fields aligned in narrow settings", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1120, height: 740 });
  const dialog = await openProxySettings(page);
  const auto = dialog.getByRole("radio", { name: "Auto-detect proxy settings", exact: true });
  const manual = dialog.getByRole("radio", { name: "Manual proxy configuration", exact: true });
  const host = dialog.getByRole("textbox", { name: "Host name:", exact: true });
  const port = dialog.getByRole("textbox", { name: /^Port number:?$/ });
  const exceptions = dialog.getByRole("textbox", { name: "No proxy for:", exact: true });
  const auth = dialog.getByRole("checkbox", { name: "Proxy authentication", exact: true });
  const login = dialog.getByRole("textbox", { name: "Login:", exact: true });
  const password = dialog.getByLabel("Password", { exact: true });
  await expect(auto).toBeChecked();
  for (const control of [host, port, exceptions, auth, login, password]) await expect(control).toBeDisabled();

  await auto.press("ArrowDown");
  await expect(manual).toBeChecked();
  await host.fill("127.0.0.1");
  await expect(login).toBeDisabled();
  await auth.check();
  await login.fill("layout-user");
  await password.fill("layout-password");

  for (const width of [1120, 580, 520]) {
    await page.setViewportSize({ width, height: 740 });
    for (const control of [host, port, exceptions, login, password]) {
      await expect(control).toBeInViewport({ ratio: 1 });
    }
    const [hostBox, portBox, exceptionsBox, loginBox, passwordBox] = await Promise.all(
      [host, port, exceptions, login, password].map((control) => control.boundingBox()),
    );
    if (!hostBox || !portBox || !exceptionsBox || !loginBox || !passwordBox) {
      throw new Error("Missing HTTP Proxy field bounds");
    }
    expect(hostBox.y).toBeLessThan(portBox.y);
    expect(portBox.y).toBeLessThan(exceptionsBox.y);
    expect(hostBox.x).toBeCloseTo(portBox.x, 0);
    expect(hostBox.x).toBeCloseTo(exceptionsBox.x, 0);
    expect(hostBox.width).toBeCloseTo(exceptionsBox.width, 0);
    expect(loginBox.x).toBeCloseTo(passwordBox.x, 0);
    expect(loginBox.width).toBeCloseTo(passwordBox.width, 0);
  }

  await auto.check();
  await expect(password).toBeDisabled();
  await manual.check();
  await expect(host).toHaveValue("127.0.0.1");
  await expect(login).toHaveValue("layout-user");
  await expect(password).toHaveValue("layout-password");
});

test("HTTP Proxy checks a URL with the staged manual settings in a narrow window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 540, height: 680 });
  await stubDesktop(page);
  await page.evaluate(() => {
    window.__ipc.handlers.proxy_check_connection = () => "200 OK";
  });
  const dialog = await openProxySettings(page);
  const check = dialog.getByRole("button", { name: "Check connection…", exact: true });
  const manual = dialog.getByRole("radio", { name: "Manual proxy configuration", exact: true });
  await manual.check();
  await expect(check).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Host name:", exact: true }).fill("proxy.example.test");
  const port = dialog.getByRole("textbox", { name: /^Port number:?$/ });
  await port.fill("8079");
  await port.press("ArrowUp");
  await expect(port).toHaveValue("8080");
  await check.click();
  const target = page.getByRole("textbox", { name: "Enter any URL to check connection to:", exact: true });
  const submit = page.getByRole("button", { name: "Check", exact: true });
  await target.fill("http://example.test/health");
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await submit.click();
  await expect(page.getByRole("status").filter({ hasText: "Connection successful: 200 OK" })).toBeVisible();
  expect(await ipcCalls(page, "proxy_check_connection")).toEqual([
    {
      proxy: expect.objectContaining({ mode: "manual", kind: "http", host: "proxy.example.test", port: 8080 }),
      url: "http://example.test/health",
    },
  ]);
  expect(await ipcCalls(page, "settings_set")).toEqual([]);
});
