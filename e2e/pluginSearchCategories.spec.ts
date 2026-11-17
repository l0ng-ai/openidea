import { doubleShift, expect, test } from "./fixtures";

test("custom search tabs preserve raw queries, activate commands and sources, and withdraw cleanly", async ({
  workbench: page,
}) => {
  await page.evaluate(async () => {
    const c = "/src/workbench/contributions.ts";
    const b = "/src/editor/core/backend.ts";
    const { registerSearchCategory } = await import(c);
    (await import(b)).docBackend().files.set("/dev/acme-api/routes.txt", "Users route declaration\n");
    const state = window as unknown as { removeCategory: () => void; searchArgs: unknown[]; selectedArg: unknown };
    state.searchArgs = [];
    state.removeCategory = registerSearchCategory({
      id: "plugin:fixture:requests",
      title: "Requests",
      command: () => ({
        id: "fixture.open",
        title: "Open request",
        run: ({ arg }: { arg?: unknown }) => {
          state.selectedArg = arg;
        },
      }),
      search: async (_request: number, query: string, limit: number) => {
        state.searchArgs.push({ query, limit });
        return {
          hasMore: false,
          items: [
            {
              id: "request",
              title: "GET /users/{id}",
              description: "Open saved request",
              target: { kind: "command", value: { id: "open", arg: query } },
            },
            {
              id: "source",
              title: "Users route",
              description: "UsersController#show",
              target: {
                kind: "location",
                value: {
                  path: "/dev/acme-api/routes.txt",
                  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } },
                  uri: null,
                },
              },
            },
          ],
        };
      },
    });
  });
  await doubleShift(page);
  const search = page.getByRole("dialog", { name: "Search Everywhere" });
  const requests = search.getByRole("tab", { name: "Requests", exact: true });
  await requests.click();
  if (process.env.OPENIDEA_SEARCH_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.OPENIDEA_SEARCH_SCREENSHOTS}/after-0.png`, animations: "disabled" });
  await search.getByRole("combobox").fill("/files /users:42");
  await expect(search.getByRole("option", { name: /GET \/users/ })).toBeVisible();
  await expect(requests).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { searchArgs: unknown[] }).searchArgs.at(-1)))
    .toEqual({ query: "/files /users:42", limit: 50 });
  if (process.env.OPENIDEA_SEARCH_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.OPENIDEA_SEARCH_SCREENSHOTS}/after-1.png`, animations: "disabled" });
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { selectedArg: unknown }).selectedArg))
    .toBe("/files /users:42");
  await page.getByRole("button", { name: "Search Everywhere", exact: true }).first().click();
  await search.getByRole("tab", { name: "Requests", exact: true }).click();
  await expect(search.getByRole("option", { name: /Users route/ })).toBeVisible();
  await search.getByRole("combobox").press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
  await expect(page.locator(".cm-content").filter({ hasText: "Users route declaration" })).toBeVisible();
  if (process.env.OPENIDEA_SEARCH_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.OPENIDEA_SEARCH_SCREENSHOTS}/after-2.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Search Everywhere", exact: true }).first().click();
  await search.getByRole("tab", { name: "Requests", exact: true }).click();
  await page.evaluate(() => (window as unknown as { removeCategory: () => void }).removeCategory());
  await expect(requests).toBeHidden();
  await expect(search.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
  if (process.env.OPENIDEA_SEARCH_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.OPENIDEA_SEARCH_SCREENSHOTS}/after-3.png`, animations: "disabled" });
});
