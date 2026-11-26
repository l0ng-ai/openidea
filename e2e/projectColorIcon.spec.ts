import { expect, stubDesktop, test } from "./fixtures";

const ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#e44"/></svg>',
  ).toString("base64");

test("a project's own icon replaces its initials; any project's colour changes from the project widget", async ({
  workbench: page,
}) => {
  await stubDesktop(page);
  await page.evaluate((icon) => {
    const handlers = window.__ipc.handlers;
    handlers.recent_projects = () => [{ name: "billing", path: "/dev/billing", branch: null, openedAtMs: 1 }];
    handlers.recent_project_groups = () => [];
    handlers.window_open_projects = () => [{ name: "acme-api", root: "/dev/acme-api", remote: null }];
    // An IntelliJ project with `.idea/icon.svg`.
    handlers.fs_read_image = (args) => {
      if ((args as { path: string }).path === "/dev/billing/.idea/icon.svg") return icon;
      throw new Error("not found");
    };
  }, ICON);

  const widget = page.getByRole("button", { name: "acme-api", exact: true });
  await widget.click();
  const popup = page.getByRole("dialog", { name: "Projects" });
  const billing = popup.getByRole("option", { name: /billing/ });
  await expect(billing.locator("img")).toHaveAttribute("src", ICON);
  // Without an icon the initials stay.
  const acme = popup.getByRole("option", { name: /acme-api/ });
  await expect(acme.locator("img")).toHaveCount(0);
  await expect(acme).toContainText("AA");

  const avatar = widget.locator("span[aria-hidden]").first();
  const color = () => avatar.evaluate((el) => getComputedStyle(el).backgroundImage);
  const before = await color();
  await acme.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change Project Color…" }).click();
  const picker = page.getByRole("dialog", { name: "Project Color" });
  await expect(picker).toBeVisible();
  await picker.getByRole("radio", { name: "Violet" }).click();
  await expect(picker).toBeHidden();
  await expect.poll(color).not.toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("openidea.tabColor.v1:/dev/acme-api"))).toBe("7");
});
