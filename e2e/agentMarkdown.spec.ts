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
  capabilities: { fork: true, rollback: true, steer: true, images: true },
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

async function openReply(page: Page, text: string, imageData?: string) {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(
    async ({ task, text, imageData }) => {
      if (imageData) {
        const routePath = "/src/platform/tauriCore.ts";
        const { setInvokeRoute } = await import(routePath);
        setInvokeRoute((cmd: string) => (cmd === "fs_read_image" ? Promise.resolve(imageData) : null));
      }
      // Paths go through variables: knip can't resolve these browser-absolute URLs.
      const storePath = "/src/features/agents/store.ts";
      const store = await import(storePath);
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([[task.id, task]]),
        entries: new Map([
          [
            task.id,
            [
              { type: "user", text: "Show Markdown", attachments: [], sentMs: 0, doneMs: 1, steered: false },
              { type: "agent", text },
            ],
          ],
        ]),
        unread: new Set(),
        docked: null,
      });
      store.dockTask(task.id);
    },
    { task: TASK, text, imageData },
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

test("loads local and web reply images", async ({ page }) => {
  await page.route("https://images.example.com/code.gif", (route) =>
    route.fulfill({ contentType: "image/gif", body: Buffer.from(PIXEL.split(",")[1]!, "base64") }),
  );
  const reply = await openReply(
    page,
    "![Local QR](/tmp/code.png)\n\n![Web QR](https://images.example.com/code.gif)",
    PIXEL,
  );
  for (const name of ["Local QR", "Web QR"]) {
    await expect
      .poll(() => reply.getByRole("img", { name }).evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
  }
});

test("copies reply Markdown with the keyboard and keeps code copying separate", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reply = await openReply(page, REPLY);
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  const actions = copy.locator("..");
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "1");
  await copy.focus();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPLY);
  await reply.getByRole("button", { name: "Copy Code", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("const a = 1;");
});

test("keeps latest reply actions visible and quotes into the draft without shifting content", async ({ page }) => {
  const reply = await openReply(page, REPLY);
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  const actions = copy.locator("..");
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "1");
  const before = await reply.boundingBox();
  await reply.hover();
  await expect(actions).toHaveCSS("opacity", "1");
  expect(await reply.boundingBox()).toEqual(before);
  await expect(actions.getByRole("button")).toHaveCount(4);
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "1");
  const userCopy = page.getByRole("button", { name: "Copy", exact: true });
  await expect(userCopy.locator("..")).toHaveCSS("opacity", "0");
  await page.getByText("Show Markdown", { exact: true }).hover();
  await expect(userCopy.locator("..")).toHaveCSS("opacity", "1");
  await reply.hover();
  await page.getByRole("button", { name: "Quote Reply", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(
    REPLY.trimEnd()
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n") + "\n\n",
  );
});

test("keeps chat history readable and selections free of timestamps and status labels", async ({ page, context }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openReply(page, "Hi! What would you like to work on?");
  await page.evaluate(async (task) => {
    const path = "/src/features/agents/store.ts";
    const store = await import(path);
    const user = (text: string) => ({ type: "user", text, attachments: [], sentMs: 1, doneMs: 5001, steered: false });
    store.useAgents.setState({
      entries: new Map([
        [
          task.id,
          [
            user("hi"),
            { type: "agent", text: "Hi! What would you like to work on?" },
            user("im bob"),
            { type: "agent", text: "Hi Bob! What are we working on today?" },
            user("yes"),
            { type: "thought", text: "**Requesting task context**" },
            { type: "agent", text: "What would you like me to proceed with?" },
          ],
        ],
      ]),
    });
    store.openTaskInEditorLocation(task.id);
  }, TASK);
  const stream = page.locator("[class*='_stream_']:visible");
  const replies = stream.locator("[class*='_reply_']");
  await expect(replies).toHaveCount(3);
  const geometry = await stream.evaluate((root) => {
    const reply = root.querySelector<HTMLElement>("[class*='_reply_']")!;
    const bubble = root.querySelector<HTMLElement>("[class*='_user_']")!;
    const composer = root
      .closest("[class*='_conversation_']")!
      .querySelector<HTMLElement>("[class*='_composerArea_']")!;
    const rr = reply.getBoundingClientRect();
    const br = bubble.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    return {
      reply: rr.width,
      root: root.clientWidth,
      bubbleLeft: br.left,
      replyLeft: rr.left,
      bubbleRight: br.right,
      replyRight: rr.right,
      columnCenter: (() => {
        const column = reply.closest("[class*='_agentMessage_']")!.getBoundingClientRect();
        return (column.left + column.right) / 2;
      })(),
      composerCenter: (cr.left + cr.right) / 2,
    };
  });
  expect(geometry.reply).toBeGreaterThan(0);
  expect(geometry.reply).toBeLessThan(geometry.root);
  expect(geometry.bubbleLeft).toBeGreaterThan(geometry.replyLeft);
  expect(geometry.bubbleRight).toBeGreaterThan(geometry.replyRight);
  expect(Math.abs(geometry.columnCenter - geometry.composerCenter)).toBeLessThan(1);
  await stream.getByText("hi", { exact: true }).hover();
  await expect(stream.locator("[class*='_messageTime_']").first()).toBeVisible();
  const selected = await stream.evaluate((root) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toContain("hi");
  expect(selected).toContain("Hi Bob!");
  expect(selected).toContain("What would you like me to proceed with?");
  expect(selected).not.toMatch(/AM|PM|5s|Reasoning|Requesting task context/);
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await stream.locator("[class*='_thought_'] > summary").click();
  await expect(stream.getByText("Requesting task context", { exact: true })).toBeVisible();
  await expect(stream.locator("[class*='_thoughtBody_'] strong")).toHaveText("Requesting task context");
  await page.evaluate(async (id) => {
    const path = "/src/features/agents/store.ts";
    const store = await import(path);
    store.dockTask(id);
  }, TASK.id);
  await expect(stream).toBeVisible();
  const narrow = await stream.evaluate((root) => ({
    width: root.clientWidth,
    content: root.scrollWidth,
    reply: root.querySelector<HTMLElement>("[class*='_reply_']")!.getBoundingClientRect().width,
    padding:
      Number.parseFloat(getComputedStyle(root).paddingLeft) + Number.parseFloat(getComputedStyle(root).paddingRight),
  }));
  expect(narrow.width).toBeGreaterThan(0);
  expect(narrow.content).toBeLessThanOrEqual(narrow.width);
  expect(narrow.reply).toBeLessThanOrEqual((narrow.width - narrow.padding) * 0.96);
});

test("keeps hover actions reachable when the pointer leaves the message body", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reply = await openReply(page, "A short answer.");
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  await reply.hover();
  const box = await copy.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 20 });
  await expect(copy.locator("..")).toHaveCSS("opacity", "1");
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("A short answer.");
});

test("selects through code blocks and tables while keeping copy controls outside the code", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const tree = "rust/\n├── Cargo.toml\n└── src/\n    └── main.rs";
  const flow = "内置文本 SAMPLE\n    ↓ parser::parse\nVec<Item>\n    ↓ Inventory::add\n终端输出";
  const text = `项目结构：\n\n\`\`\`text\n${tree}\n\`\`\`\n\n| 模块 | 职责 |\n| --- | --- |\n| main.rs | 程序入口 |\n\n数据流是：\n\n\`\`\`text\n${flow}\n\`\`\``;
  const reply = await openReply(page, text);
  await expect(reply.getByRole("button", { name: "Copy Code", exact: true })).toHaveCount(2);
  const selected = await reply.evaluate((root) => {
    const codes = [...root.querySelectorAll("pre > code")];
    if (codes.some((code) => code.parentElement!.querySelector("button"))) throw new Error("Control in code selection");
    const start = root.querySelector("p")!.firstChild!;
    const end = codes.at(-1)!.lastChild!;
    window.getSelection()!.setBaseAndExtent(start, 0, end, end.textContent!.length);
    return window.getSelection()!.toString();
  });
  expect(selected).toContain(tree);
  expect(selected).toContain("程序入口");
  expect(selected).toContain(flow);
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  const copies = reply.getByRole("button", { name: "Copy Code", exact: true });
  await copies.first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(tree);
  await copies.last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(flow);
});
