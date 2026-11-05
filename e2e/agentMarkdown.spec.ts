/** Markdown in agent replies, in the real conversation: browser defaults don't suit a narrow chat. */
import { expect, test, type Page } from "@playwright/test";

const TASK = {
  id: "t1",
  title: "Repro task",
  status: "ready" as const,
  isolation: "local" as const,
  provider: "codex",
  model: null,
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [],
  commands: [],
  usage: null,
  queue: [],
};

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const REPLY = [
  "# Heading one",
  "",
  "## Heading two",
  "",
  "##### Heading five",
  "",
  "> A quote",
  "",
  "- [x] done",
  "- [ ] open",
  "",
  "---",
  "",
  `![pixel](${PIXEL})`,
  "",
  "| Path | Owner | Status | Notes |",
  "| --- | --- | --- | --- |",
  "| src/features/agents/conversation/very/long/path/file.tsx | someone | modified | a fairly long note |",
  "",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");

async function openReply(page: Page, text: string) {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(
    async ({ task, text }) => {
      // Paths go through variables: knip can't resolve these browser-absolute URLs.
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([[task.id, task]]),
        entries: new Map([[task.id, [{ type: "agent", text }]]]),
        unread: new Set(),
        docked: null,
      });
      store.dockTask(task.id);
    },
    { task: TASK, text },
  );
  const reply = page.locator("[class*='_markdown_']").first();
  await reply.locator("h1, p").first().waitFor();
  return reply;
}

const css = (reply: ReturnType<Page["locator"]>, selector: string, property: string) =>
  reply
    .locator(selector)
    .first()
    .evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);
const px = (value: string) => Number.parseFloat(value);

test("styles tables so a reply reads as a table", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  expect(await css(reply, "td", "border-top-width")).toBe("1px");
  expect(await css(reply, "td", "padding-left")).toBe("8px");
  expect(await css(reply, "th", "border-top-width")).toBe("1px");
  // A narrow chat must not squeeze a column to a few letters.
  const widths = await reply
    .locator("td")
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(70);
});

test("scrolls a wide table inside the reply", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  const sizes = await reply.evaluate((el) => {
    const table = el.querySelector("table")!;
    return { reply: el.clientWidth, table: table.clientWidth, content: table.scrollWidth };
  });
  expect(sizes.table).toBeLessThanOrEqual(sizes.reply);
  expect(sizes.content).toBeGreaterThan(sizes.table);
});

test("sizes headings for a chat and keeps small ones readable", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  const body = px(await css(reply, "td", "font-size"));
  const h1 = px(await css(reply, "h1", "font-size"));
  expect(h1).toBeGreaterThan(body);
  expect(h1).toBeLessThanOrEqual(body * 1.2);
  expect(px(await css(reply, "h2", "font-size"))).toBeLessThan(h1);
  expect(px(await css(reply, "h5", "font-size"))).toBe(body);
});

test("starts and ends a reply without stray margins", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  expect(await css(reply, "> :first-child", "margin-top")).toBe("0px");
  expect(await css(reply, "> :last-child", "margin-bottom")).toBe("0px");
});

test("styles quotes, rules, images and task lists", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  expect(await css(reply, "blockquote", "margin-left")).toBe("0px");
  expect(await css(reply, "blockquote", "border-left-width")).toBe("3px");
  expect(await css(reply, "hr", "border-left-width")).toBe("0px");
  expect(await css(reply, "hr", "border-top-width")).toBe("1px");
  expect(await css(reply, "img", "max-width")).toBe("100%");
  // A checkbox stands in for the bullet.
  expect(await css(reply, "li:has(> input)", "list-style-type")).toBe("none");
});
