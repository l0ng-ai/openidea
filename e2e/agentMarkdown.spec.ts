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

async function openReply(page: Page, text: string, imageData?: string, theme?: "dark" | "light") {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(
    async ({ task, text, imageData, theme }) => {
      if (theme) document.documentElement.dataset.theme = theme;
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
              {
                type: "user",
                text: "Show Markdown",
                attachments: [],
                sentMs: 0,
                doneMs: 1,
                steered: false,
              },
              { type: "agent", text },
            ],
          ],
        ]),
        unread: new Set(),
        docked: null,
      });
      store.dockTask(task.id);
    },
    { task: TASK, text, imageData, theme },
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

test("opens Windows file links in the editor at their line and column", async ({ page }) => {
  const path = "E:/work/笔记 list.txt";
  const reply = await openReply(
    page,
    "[Windows file](E:/work/笔记%20list.txt:3:5)\n\n[Backslash path](E:%5Cwork%5C笔记%20list.txt#L7)",
  );
  await page.evaluate(async (path) => {
    const backendPath = "/src/editor/core/backend.ts";
    const { docBackend } = await import(backendPath);
    docBackend().files.set(path, Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: Windows file link`).join("\n"));
  }, path);

  await reply.getByRole("link", { name: "Windows file", exact: true }).click();
  const cursor = () =>
    page.evaluate(async () => {
      const servicePath = "/src/workbench/contributions.ts";
      const { editorService } = await import(servicePath);
      return { path: editorService().activePath(), cursor: editorService().activeCursor() };
    });
  await expect.poll(cursor).toMatchObject({ path, cursor: { line: 2, col: 4 } });
  await expect(page.locator(".cm-content").first()).toContainText("Line 3: Windows file link");

  await reply.getByRole("link", { name: "Backslash path", exact: true }).click();
  await expect.poll(cursor).toMatchObject({ path, cursor: { line: 6, col: 0 } });
});

test("opens slash-prefixed Windows Markdown links with preview content and hover targets", async ({ page }) => {
  const spec = "E:/work/feature/spec.md";
  const skill = "E:/work/.agents/skills/work-spec/SKILL.md";
  const reply = await openReply(page, `[Specification](/${spec})\n\n[Work skill](/${skill})`);
  await page.evaluate(
    async ({ spec, skill }) => {
      const backendPath = "/src/editor/core/backend.ts";
      const modePath = "/src/features/viewers/markdown/modes.ts";
      const { docBackend } = await import(backendPath);
      const { setMarkdownMode } = await import(modePath);
      docBackend().files.set(spec, "# Windows specification\n\nThe specification is not empty.");
      docBackend().files.set(skill, "# Work specification skill\n\nThe skill is not empty.");
      setMarkdownMode(spec, "preview");
      setMarkdownMode(skill, "preview");
    },
    { spec, skill },
  );

  for (const [label, path, heading] of [
    ["Specification", spec, "Windows specification"],
    ["Work skill", skill, "Work specification skill"],
  ] as const) {
    const link = reply.getByRole("link", { name: label, exact: true });
    await link.hover();
    await expect(link).toHaveAttribute("title", path);
    await link.click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const servicePath = "/src/workbench/contributions.ts";
          return (await import(servicePath)).editorService().activePath();
        }),
      )
      .toBe(path);
  }
});

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
    return {
      reply: el.clientWidth,
      table: table.clientWidth,
      content: table.scrollWidth,
    };
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

test("loads local reply images, and web ones when asked", async ({ page }) => {
  let fetched = 0;
  await page.route("https://images.example.com/code.gif", (route) => {
    fetched++;
    return route.fulfill({
      contentType: "image/gif",
      body: Buffer.from(PIXEL.split(",")[1]!, "base64"),
    });
  });
  const reply = await openReply(
    page,
    "![Local QR](/tmp/code.png)\n\n![Web QR](https://images.example.com/code.gif)",
    PIXEL,
  );
  const width = (name: string) =>
    reply.getByRole("img", { name, includeHidden: true }).evaluate((img: HTMLImageElement) => img.naturalWidth);
  await expect.poll(() => width("Local QR")).toBe(1);
  const load = reply.getByRole("button", {
    name: "Load image from images.example.com",
  });
  await expect(load).toBeVisible();
  expect(fetched).toBe(0);
  await load.click();
  await expect.poll(() => width("Web QR")).toBe(1);
  expect(fetched).toBe(1);
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

test("copies a reply link's address from its context menu and keeps Copy for the selected text", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const url = "https://example.com/pull/42?tab=files#diff";
  const reply = await openReply(page, `[**Review changes**](${url})\n\nOrdinary reply text`);
  const link = reply.getByRole("link", { name: "Review changes" });
  await link.locator("strong").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy Link Address" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  await link.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await link.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: /^Copy\b/ })
    .first()
    .click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("Review changes");

  const paragraph = reply.getByText("Ordinary reply text", { exact: true });
  await paragraph.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy Link Address" })).toHaveCount(0);
  await page.keyboard.press("Escape");
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
  // Quoted as `> ` lines, drawn as a block without their markers, an empty line to type in after it.
  const quoted = REPLY.trimEnd().split("\n");
  await expect(draft.locator(".cm-line")).toHaveText([...quoted, "", ""]);
  await expect(draft.locator(".cm-line[class*='_quoteLine_']")).toHaveCount(quoted.length);
});

test("copies a mouse selection with Ctrl+C and pops up no Quote button", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reply = await openReply(page, "Selectable answer");
  const box = (await reply.locator("p").first().boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Selectable answer");
  await expect(page.getByRole("button", { name: "Quote", exact: true })).toHaveCount(0);
});

test("keeps chat history readable and selections free of timestamps and status labels", async ({ page, context }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openReply(page, "Hi! What would you like to work on?");
  await page.evaluate(async (task) => {
    const path = "/src/features/agents/store.ts";
    const store = await import(path);
    const user = (text: string) => ({
      type: "user",
      text,
      attachments: [],
      sentMs: 1,
      doneMs: 5001,
      steered: false,
    });
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
  // The finished turn's reasoning is folded with its work.
  await stream.locator("[class*='_turnFold_'] > summary").click();
  await stream.locator("[class*='_thought_'] > summary").click();
  await expect(stream.locator("[class*='_thoughtPreview_']")).toHaveText("Requesting task context");
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

test("fits conversation stream, composer, question card and off-screen rows live from Settings without restarting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openReply(page, "Initial reply");
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    const filler = Array.from({ length: 8 }, (_, i) => ({
      type: "agent" as const,
      text: `Earlier paragraph ${i + 1}: ` + "wrapped words across the column ".repeat(35),
    }));
    store.useAgents.setState({
      tasks: new Map([[task.id, { ...task, status: "needsInput" as const }]]),
      entries: new Map([
        [
          task.id,
          [
            ...filler,
            {
              type: "user",
              text: "Long prompt ".repeat(40),
              attachments: [],
              sentMs: 1,
              doneMs: 2,
              steered: false,
            },
            { type: "agent", text: "Wide reply body." },
            {
              type: "permission",
              id: 1,
              title: "Choose layout",
              options: [],
              chosen: null,
              questions: [
                {
                  header: "Width",
                  question: "Use full window width?",
                  multiSelect: false,
                  options: [{ label: "Yes", description: "Fill the pane", preview: null }],
                },
              ],
            },
          ],
        ],
      ]),
    });
    store.openTaskInEditorLocation(task.id);
  }, TASK);

  const stream = page.locator("[class*='_stream_']:visible");
  await expect(page.getByRole("form", { name: "Choose layout" })).toBeVisible();
  await expect(stream.locator("[data-measured]").first()).toBeAttached();

  const measure = () =>
    stream.evaluate((root) => {
      const conversation = root.closest<HTMLElement>("[class*='_conversation_']")!;
      const rows = [...root.querySelectorAll<HTMLElement>("[class*='_conversationRow_']")];
      const column = [...root.querySelectorAll<HTMLElement>("[class*='_agentMessage_']")]
        .at(-1)!
        .getBoundingClientRect();
      const bubble = root.querySelector<HTMLElement>("[class*='_user_']")!.getBoundingClientRect();
      const composer = conversation.querySelector<HTMLElement>("[class*='_composerArea_']")!.getBoundingClientRect();
      const question = conversation.querySelector<HTMLElement>("[class*='_questionCard_']")!.getBoundingClientRect();
      const padding =
        Number.parseFloat(getComputedStyle(root).paddingLeft) + Number.parseFloat(getComputedStyle(root).paddingRight);
      return {
        conversationWidth: conversation.clientWidth,
        streamInnerWidth: root.clientWidth - padding,
        columnWidth: column.width,
        bubbleWidth: bubble.width,
        composerWidth: composer.width,
        questionWidth: question.width,
        offscreenRowHeight: rows[0]!.getBoundingClientRect().height,
        scrollHeight: root.scrollHeight,
      };
    });

  const capped = await measure();
  expect(capped.conversationWidth).toBeGreaterThan(1000);
  expect(Math.abs(capped.columnWidth - 900)).toBeLessThan(1);
  expect(Math.abs(capped.bubbleWidth - 720)).toBeLessThan(1);
  expect(Math.abs(capped.composerWidth - 924)).toBeLessThan(1);
  expect(Math.abs(capped.questionWidth - 900)).toBeLessThan(1);

  // Toggle on through Settings › Agents › Chat › Apply and verify live re-layout including off-screen rows.
  await page.evaluate(async () => {
    const actionsPath = "/src/platform/actions.ts";
    const { executeAction } = await import(actionsPath);
    await executeAction("file.settings", "agents.chat");
  });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const toggle = dialog.getByRole("checkbox", { name: "Fit conversation to the window width" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(stream.locator("[data-measured]").first()).toBeAttached();

  const fitted = await measure();
  expect(Math.abs(fitted.columnWidth - fitted.streamInnerWidth)).toBeLessThan(1);
  expect(fitted.bubbleWidth).toBeGreaterThan(720);
  expect(Math.abs(fitted.bubbleWidth - fitted.streamInnerWidth * 0.8)).toBeLessThan(1);
  expect(Math.abs(fitted.composerWidth - fitted.conversationWidth)).toBeLessThan(1);
  expect(Math.abs(fitted.questionWidth - fitted.streamInnerWidth)).toBeLessThan(1);
  expect(fitted.offscreenRowHeight).toBeLessThan(capped.offscreenRowHeight);
  expect(fitted.scrollHeight).toBeLessThan(capped.scrollHeight);

  // Toggle back off and click OK: dialog closes and conversation returns to the 900px column live.
  await toggle.click();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(stream.locator("[data-measured]").first()).toBeAttached();

  const restored = await measure();
  expect(Math.abs(restored.columnWidth - 900)).toBeLessThan(1);
  expect(Math.abs(restored.offscreenRowHeight - capped.offscreenRowHeight)).toBeLessThan(1);
});

test("keeps hover actions reachable when the pointer leaves the message body", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const reply = await openReply(page, "A short answer.");
  const copy = page.getByRole("button", { name: "Copy Markdown", exact: true });
  await reply.hover();
  const box = await copy.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, {
    steps: 20,
  });
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

test("keeps mermaid `<style>` rules scoped to the rendered svg after id rewriting", async ({ page }) => {
  const diagram = [
    "```mermaid",
    "%%{init: {'theme': 'base', 'flowchart': {'htmlLabels': false, 'curve': 'basis'}}}%%",
    "flowchart TB",
    '    subgraph T1["Tier 1"]',
    "        A[(Local)] <--> B[(Peer)]",
    "    end",
    '    subgraph T2["Tier 2"]',
    "        C[(Host RAM)]",
    "    end",
    '    C -->|"PCIe"| A',
    "```",
  ].join("\n");
  const reply = await openReply(page, `Diagram:\n\n${diagram}`);
  await expect(reply.locator("[data-mermaid-state='ok'] .mermaid-output svg")).toBeVisible();
  expect(await css(reply, ".cluster rect", "fill")).not.toBe("rgb(0, 0, 0)");
  expect(await css(reply, ".flowchart-link", "fill")).toBe("none");
});

test("renders KaTeX math in mermaid labels", async ({ page }) => {
  const diagram = ["```mermaid", "flowchart LR", '  A["$$x^2 + \\frac{a}{b}$$"] --> B', "```"].join("\n");
  const reply = await openReply(page, `Diagram:\n\n${diagram}`);
  const svg = reply.locator("[data-mermaid-state='ok'] .mermaid-output svg");
  await expect(svg).toBeVisible();
  await expect(svg.locator("math mfrac")).toHaveCount(1);
});

test("keeps mermaid flowchart nodes and sequence control blocks off solid black", async ({ page }) => {
  const flow = [
    "```mermaid",
    "flowchart LR",
    '  subgraph Client["Client"]',
    '    A["Local agent"]',
    '    B["Voice input"]',
    "  end",
    '  subgraph Cloud["Cloud"]',
    '    C["Cloud agent"]',
    '    D["Memory service"]',
    "  end",
    "  B --> A",
    "  A --> C",
    "  C --> D",
    "```",
  ].join("\n");
  const sequence = ["```mermaid", "sequenceDiagram", "  loop every minute", "    A->>B: ping", "  end", "```"].join(
    "\n",
  );
  const reply = await openReply(page, `Flow:\n\n${flow}\n\nSequence:\n\n${sequence}`);
  await expect(reply.locator("[data-mermaid-state='ok'] .mermaid-output svg")).toHaveCount(2);
  expect(await css(reply, ".node rect", "fill")).not.toBe("rgb(0, 0, 0)");
  expect(await css(reply, ".cluster rect", "fill")).not.toBe("rgb(0, 0, 0)");
  expect(await css(reply, ".labelBox", "fill")).not.toBe("rgb(0, 0, 0)");
});

const DIAGRAMS = [
  "flowchart LR\n  subgraph Client\n    A[Local agent] --> B[Voice input]\n  end",
  "sequenceDiagram\n  loop every minute\n    A->>B: ping\n  end",
  "classDiagram\n  class Agent {\n    +String name\n    +run()\n  }",
  "stateDiagram-v2\n  [*] --> Ready\n  Ready --> Running\n  Running --> [*]",
  'pie title Work\n  "Ready" : 40\n  "Running" : 35\n  "Done" : 25',
  "gantt\n  dateFormat YYYY-MM-DD\n  section Delivery\n  Shipped :done, shipped, 2026-01-01, 5d\n  Building :active, building, after shipped, 5d\n  Next :next, after building, 5d\n  Critical :crit, critical, after next, 5d",
]
  .map((source) => `\`\`\`mermaid\n${source}\n\`\`\``)
  .join("\n\n");

for (const theme of ["dark", "light"] as const) {
  test(`keeps Mermaid shapes, labels and chart series readable in ${theme} theme`, async ({ page }) => {
    const reply = await openReply(page, `Diagrams:\n\n${DIAGRAMS}`, undefined, theme);
    const svgs = reply.locator("[data-mermaid-state='ok'] .mermaid-output svg");
    await expect(svgs).toHaveCount(6);
    for (const [index, selector] of [
      [0, ".node rect"],
      [1, ".labelBox"],
      [2, ".outer-path path"],
      [3, ".node rect"],
    ] as const) {
      expect(await css(svgs.nth(index), selector, "fill")).not.toBe("rgb(0, 0, 0)");
      expect(await css(svgs.nth(index), selector, "stroke")).not.toContain("url(");
    }
    expect(await css(svgs.nth(2), ".nodeLabel", "color")).not.toBe(await css(svgs.nth(2), ".outer-path path", "fill"));
    const slices = await svgs
      .nth(4)
      .locator(".pieCircle")
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).fill));
    expect(new Set(slices).size).toBe(3);
    expect(slices).not.toContain("rgb(0, 0, 0)");
    const contrasts = await svgs
      .nth(5)
      .locator("text.taskText")
      .evaluateAll((els) => {
        const luminance = (color: string) => {
          const [r, g, b] = color
            .match(/\d+/g)!
            .map(Number)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        return els.map((el) => {
          const bar = document.getElementById(el.id.replace(/-text$/, ""))!;
          const fg = luminance(getComputedStyle(el).fill);
          const bg = luminance(getComputedStyle(bar).fill);
          return {
            text: el.textContent,
            ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
          };
        });
      });
    expect(contrasts).toHaveLength(4);
    for (const { text, ratio } of contrasts) expect(ratio, `${theme}: ${text}`).toBeGreaterThanOrEqual(4.5);
  });
}

test("draws a diagram without reaching the hosts its configuration names", async ({ page }) => {
  const asked: string[] = [];
  await page.route(/^https:\/\/([a-z\d-]+\.)*example\.com\//, (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      contentType: "image/gif",
      body: Buffer.from(PIXEL.split(",")[1]!, "base64"),
    });
  });
  const at = (name: string) => `https://images.example.com/${name}`;
  const fence = (...lines: string[]) => ["```mermaid", ...lines, "```"].join("\n");
  const diagrams = [
    fence(
      `%%{init: {"themeCSS": ".nodeLabel{background-image:url(${at("theme-css")})} svg{background-image:url(${at("theme-css-root")})}"}}%%`,
      "flowchart TD",
      "    A[One]-->B[Two]",
    ),
    fence(
      `%%{init: {"fontFamily": "x;background-image:url(${at("font-family")})"}}%%`,
      "flowchart TD",
      "    A[One]-->B[Two]",
    ),
    fence(
      "---",
      "config:",
      `  themeCSS: ".nodeLabel{background-image:url(${at("front-matter")})}"`,
      "---",
      "flowchart TD",
      "    A[One]-->B[Two]",
    ),
  ];
  const reply = await openReply(page, `Diagrams:\n\n${diagrams.join("\n\n")}`);
  await expect(reply.locator("[data-mermaid-state='ok'] .mermaid-output svg")).toHaveCount(diagrams.length);
  await page.evaluate(
    (src) =>
      new Promise<void>((done) => {
        const img = new Image();
        img.onload = img.onerror = () => done();
        img.src = src;
      }),
    "https://example.com/after",
  );
  expect(asked).toEqual(["/after"]);
});

test("Find in Conversation skips user-select:none summaries and closed <details> until stepped into", async ({
  page,
}) => {
  await openReply(page, "Confirmed—PR is merged.");
  await page.evaluate(async (task) => {
    const path = "/src/features/agents/store.ts";
    const store = await import(path);
    store.useAgents.setState({
      entries: new Map([
        [
          task.id,
          [
            {
              type: "thought",
              text: "**Confirming Active Watch Shell**\n\nCheck background shell before rebasing.",
            },
            {
              type: "tool",
              id: "t1",
              title: "stop_bash",
              kind: "other",
              status: "completed",
              locations: [],
              output: "<command with id: 60 had already stopped>",
              diffs: [],
            },
            { type: "agent", text: "Confirmed—PR is merged." },
          ],
        ],
      ]),
    });
    store.openTaskInEditorLocation(task.id);
  }, TASK);

  const stream = page.locator("[class*='_stream_']:visible");
  const runSummary = stream.locator("details[class*='_processRun_'] > summary");
  await runSummary.click();
  await expect(stream.getByText("stop_bash")).toBeVisible();

  await stream.focus();
  await page.keyboard.press("Meta+f");
  const findBox = page.getByLabel("Find in Conversation");
  await findBox.fill("confirm");

  // 2 matches total (1 inside collapsed thought body, 1 in visible reply); unselectable <summary> is excluded.
  await expect(page.locator("[class*='_findCount_']")).toHaveText("1/2");
  const initialHighlights = await page.evaluate(() => ({
    find: [...(CSS.highlights.get("agent-find") ?? [])].map((r) => (r as Range).startContainer.textContent),
    current: [...(CSS.highlights.get("agent-find-current") ?? [])].map((r) => (r as Range).startContainer.textContent),
  }));
  expect(initialHighlights.find).toEqual(["Confirmed—PR is merged."]);
  expect(initialHighlights.current).toEqual([]);

  // Stepping to match 2/2 opens the collapsed thought <details> and highlights it.
  await findBox.press("Enter");
  await expect(page.locator("[class*='_findCount_']")).toHaveText("2/2");
  await findBox.press("Enter");
  await expect(page.locator("[class*='_findCount_']")).toHaveText("1/2");
  const expandedHighlights = await page.evaluate(() => ({
    thoughtOpen: document.querySelector<HTMLDetailsElement>("details[class*='_thought_']")?.open,
    findCount: CSS.highlights.get("agent-find")?.size ?? 0,
    currentCount: CSS.highlights.get("agent-find-current")?.size ?? 0,
  }));
  expect(expandedHighlights).toEqual({ thoughtOpen: true, findCount: 2, currentCount: 1 });
});

test("keeps ordered, bulleted and task list markers unclipped inside measured rows when zoomed in", async ({
  page,
}) => {
  const numbered = Array.from({ length: 10 }, (_, i) => `${i + 1}. **Item ${i + 1}**\n   - Nested bullet`).join("\n");
  await openReply(page, `## Feature Gaps\n\n${numbered}\n\n- [x] Checked task\n- [ ] Open task`);
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const actionsPath = "/src/platform/actions.ts";
    const store = await import(storePath);
    const { executeAction } = await import(actionsPath);
    store.openTaskInEditorLocation(task.id);
    await new Promise((r) => setTimeout(r, 150));
    const stream = document.querySelector<HTMLElement>("[class*='_stream_']");
    stream?.focus();
    for (let i = 0; i < 12; i++) await executeAction("editor.increaseFontSize");
  }, TASK);

  const stream = page.locator("[class*='_stream_']:visible");
  const row = stream.locator("[class*='_conversationRow_'][data-measured]", { has: page.locator("ol") });
  await expect(row).toBeVisible();

  const bounds = await row.evaluate((rowEl) => {
    const rowLeft = rowEl.getBoundingClientRect().left;
    const items = [...rowEl.querySelectorAll<HTMLElement>("ol > li, ul > li")];
    const markers = items
      .filter((li) => getComputedStyle(li, "::before").content !== "none")
      .map((li) => {
        const rect = li.getBoundingClientRect();
        const before = getComputedStyle(li, "::before");
        const lineHeight = Number.parseFloat(getComputedStyle(li).lineHeight);
        const markerRight = rect.right - Number.parseFloat(before.right);
        const markerLeft = markerRight - Number.parseFloat(before.width);
        return {
          text: li.firstChild?.textContent?.trim() ?? "",
          offsetFromRowLeft: Math.round((markerLeft - rowLeft) * 100) / 100,
          singleLine: Number.parseFloat(before.height) <= lineHeight * 1.15,
        };
      });
    const checkboxes = [...rowEl.querySelectorAll<HTMLInputElement>('li > input[type="checkbox"]')].map((input) => ({
      offsetFromRowLeft: Math.round((input.getBoundingClientRect().left - rowLeft) * 100) / 100,
    }));
    return { fontSize: getComputedStyle(streamElement()!).fontSize, markers, checkboxes };
    function streamElement() {
      return rowEl.closest<HTMLElement>("[class*='_stream_']");
    }
  });

  expect(bounds.fontSize).toBe("25px");
  expect(bounds.markers.length).toBeGreaterThanOrEqual(10);
  for (const m of bounds.markers) {
    expect(m.singleLine, `single-line marker for ${m.text}`).toBe(true);
    expect(m.offsetFromRowLeft, `marker for ${m.text}`).toBeGreaterThanOrEqual(0);
  }
  for (const cb of bounds.checkboxes) {
    expect(cb.offsetFromRowLeft).toBeGreaterThanOrEqual(0);
  }
});

test("indents process-run thoughts and tool calls clearly and aligns output-less tool icons", async ({ page }) => {
  await openReply(page, "All checks passed.");
  await page.evaluate(async (task) => {
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    store.useAgents.setState({
      tasks: new Map([[task.id, { ...task, status: "running" as const }]]),
      entries: new Map([
        [
          task.id,
          [
            { type: "thought", text: "**Checking CI Status**\n\nInspecting workflow runs." },
            {
              type: "tool",
              id: "t1",
              title: "gh pr checks 3631 --repo l0ng-ai/openidea",
              kind: "execute",
              status: "completed",
              locations: [],
              output: "All checks pending",
              diffs: [],
            },
            { type: "thought", text: "**Tracking Continuous Integration**\n\nWaiting for E2E." },
            {
              type: "tool",
              id: "t2",
              title: "read_bash",
              kind: "other",
              status: "completed",
              locations: [],
              output: "E2E pass",
              diffs: [],
            },
            {
              type: "tool",
              id: "t3",
              title: "read_bash",
              kind: "other",
              status: "running",
              locations: [],
              output: "",
              diffs: [],
            },
          ],
        ],
      ]),
    });
    store.openTaskInEditorLocation(task.id);
  }, TASK);

  const stream = page.locator("[class*='_stream_']:visible");
  const summary = stream.locator("[class*='_processSummary_']").first();
  await summary.click();
  await expect(stream.getByText("Checking CI Status")).toBeVisible();

  const layout = await stream.evaluate((root) => {
    const summaryChevron = root.querySelector<SVGElement>("[class*='_processChevron_']")!.getBoundingClientRect();
    const processBody = root.querySelector<HTMLElement>("[class*='_processBody_']")!.getBoundingClientRect();
    const thoughtChevron = root.querySelector<SVGElement>("[class*='_thoughtChevron_']")!.getBoundingClientRect();
    const toolRows = [...root.querySelectorAll<HTMLElement>("[class*='_tool_']")];
    const expandableToolChevron = toolRows[0]!
      .querySelector<SVGElement>("[class*='_toolChevron_']")!
      .getBoundingClientRect();
    const kindIcon = (row: HTMLElement) => row.querySelector<SVGElement>("[class*='_toolKindIcon_']")!;
    const completedReadIcon = kindIcon(toolRows[1]!).getBoundingClientRect();
    const runningReadIcon = kindIcon(toolRows[2]!).getBoundingClientRect();
    return {
      summaryChevronCenter: summaryChevron.left + summaryChevron.width / 2,
      guideLeft: processBody.left,
      summaryToThoughtIndent: thoughtChevron.left - summaryChevron.left,
      thoughtToToolIndent: expandableToolChevron.left - thoughtChevron.left,
      iconLeftDiff: Math.abs(completedReadIcon.left - runningReadIcon.left),
    };
  });

  // Guide line drops from the center of the process summary chevron.
  expect(Math.abs(layout.guideLeft - layout.summaryChevronCenter)).toBeLessThanOrEqual(1.5);
  // Thoughts indent clearly inside the process run, and tool calls indent under their thought step.
  expect(layout.summaryToThoughtIndent).toBeGreaterThanOrEqual(20);
  expect(layout.thoughtToToolIndent).toBeGreaterThanOrEqual(14);
  // Output-less running tool rows align their kind icon with expandable tool rows.
  expect(layout.iconLeftDiff).toBeLessThanOrEqual(1);
});

test("aligns Mermaid diagrams in replies to their container align attribute", async ({ page }) => {
  const diagram = ["```mermaid", "flowchart LR", "  A --> B", "```"].join("\n");
  await openReply(
    page,
    [
      "Summary across the full width of the reply column so diagrams sit inside a wider message body.",
      "",
      diagram,
      "",
      '<div align="left" style="width: 960px; max-width: 100%; margin-left: 0; text-align: left;">',
      "",
      diagram,
      "",
      "</div>",
      "",
      '<div align="right">',
      "",
      diagram,
      "",
      "</div>",
      "",
      '<div align="left"><div align="center">',
      "",
      diagram,
      "",
      "</div></div>",
    ].join("\n"),
  );
  await page.evaluate(async (id) => {
    const storePath = "/src/features/agents/store.ts";
    const store = await import(storePath);
    store.openTaskInEditorLocation(id);
  }, TASK.id);

  const reply = page.locator("[class*='_stream_']:visible [class*='_markdown_']").first();
  const outputs = reply.locator("[data-mermaid-state='ok'] .mermaid-output");
  await expect(outputs).toHaveCount(4);

  const offsets = await outputs.evaluateAll((els) =>
    els.map((out) => {
      const outRect = out.getBoundingClientRect();
      const svgRect = out.querySelector("svg")!.getBoundingClientRect();
      return {
        leftGap: svgRect.left - outRect.left,
        rightGap: outRect.right - svgRect.right,
      };
    }),
  );

  expect(offsets[0]!.leftGap).toBeGreaterThan(20);
  expect(Math.abs(offsets[0]!.leftGap - offsets[0]!.rightGap)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(offsets[1]!.leftGap)).toBeLessThanOrEqual(1);
  expect(offsets[1]!.rightGap).toBeGreaterThan(40);
  expect(offsets[2]!.leftGap).toBeGreaterThan(40);
  expect(Math.abs(offsets[2]!.rightGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(offsets[3]!.leftGap - offsets[3]!.rightGap)).toBeLessThanOrEqual(1.5);
});

test("renders LaTeX math formulas with KaTeX and keeps wide equations scrollable", async ({ page }) => {
  const reply = await openReply(
    page,
    [
      "Inline $E = mc^2$ and \\(a^2 + b^2 = c^2\\), prices $5 and $10 stay plain.",
      "",
      "$$",
      "\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}",
      "$$",
      "",
      "```math",
      "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2} + a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10}",
      "```",
    ].join("\n"),
  );
  await expect(reply.locator(".katex")).toHaveCount(4);
  await expect(reply.locator(".katex-display")).toHaveCount(2);
  await expect(reply).toContainText("prices $5 and $10 stay plain.");

  const layout = await reply.evaluate((el) => {
    const firstKatex = el.querySelector<HTMLElement>(".katex")!;
    const display = el.querySelectorAll<HTMLElement>(".katex-display");
    const font = getComputedStyle(firstKatex).fontFamily;
    return {
      font,
      height: firstKatex.getBoundingClientRect().height,
      overflowX: getComputedStyle(display[1]!).overflowX,
    };
  });
  expect(layout.font).toContain("KaTeX_Main");
  expect(layout.height).toBeGreaterThan(10);
  expect(layout.overflowX).toBe("auto");
});
