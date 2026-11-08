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

test("a rejected boot shows Chinese diagnostics without application modules", async ({ browser }) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await context.route("https://github.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Issue report destination" }),
    );
    await page.route("**/src/main.tsx", (route) =>
      route.fulfill({ contentType: "text/javascript", body: 'await Promise.reject(new Error("Boot rejected"));' }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "OpenIDEA 无法启动" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "启动错误详情" })).toHaveValue(/Boot rejected/);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (value: string) => sessionStorage.setItem("copied-diagnostics", value) },
      });
    });
    await page.getByRole("button", { name: "复制详情" }).click();
    await expect(page.getByRole("status")).toHaveText("已复制");
    expect(await page.evaluate(() => sessionStorage.getItem("copied-diagnostics"))).toContain("Boot rejected");
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: "报告问题" }).click();
    await expect(await popup).toHaveURL("https://github.com/l0ng-ai/openidea/issues/new?template=bug_report.yml");
  } finally {
    await context.close();
  }
});

test("a slow module load succeeds before the deadline and cancels the startup timer", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes].some((node) => node instanceof Element && node.id === "boot-error"),
        )
      )
        sessionStorage.setItem("boot-error-seen", "true");
    }).observe(document, { childList: true, subtree: true });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const moduleRequest = page.waitForRequest("**/src/main.tsx");
  await page.goto("/", { waitUntil: "commit" });
  await moduleRequest;
  await page.locator("#splash").waitFor({ state: "attached" });
  await page.clock.runFor(25_000);
  await expect(page.locator("#boot-error")).toHaveCount(0);
  release();
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.clock.runFor(4000);
  await expect(page.locator("#splash")).toHaveCount(0);
  await page.clock.runFor(35_000);
  await expect(page.locator("#boot-error")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("boot-error-seen"))).toBeNull();
});
