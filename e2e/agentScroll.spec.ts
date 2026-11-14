import { expect, test, type Page } from "@playwright/test";
import type { AgentEntry, AgentTask } from "../src/bindings";

const task: AgentTask = {
  id: "long-chat",
  title: "Long conversation",
  status: "ready",
  isolation: "local",
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

const entries: AgentEntry[] = Array.from({ length: 80 }, (_, turn): AgentEntry[] => [
  { type: "user", text: `Request ${turn}`, attachments: [], steered: false },
  ...["read", "execute", "edit"].map((kind): AgentEntry => ({
    type: "tool",
    id: `${turn}-${kind}`,
    kind,
    title: `${kind} src/module-${turn}.ts`,
    status: "completed",
    locations: [],
    output: Array.from({ length: 80 }, (_, line) => `output ${turn}:${line}`).join("\n"),
    diffs: [],
  })),
  { type: "thought", text: `Checking module ${turn}.\n\n${"Details of the investigation. ".repeat(30)}` },
  {
    type: "agent",
    text: `Reply ${turn}\n\n- Checked the module.\n- Updated the implementation.\n\n\`\`\`text\nmodule-${turn}\n  src/\n  tests/\n\`\`\``,
  },
]).flat();

async function openHistory(page: Page) {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(
    async ({ task, entries }) => {
      const path = "/src/features/agents/store.ts";
      const store = await import(path);
      store.useAgents.setState({
        loaded: true,
        error: null,
        providers: [],
        tasks: new Map([[task.id, task]]),
        entries: new Map([[task.id, entries]]),
        unread: new Set(),
        docked: null,
      });
      store.openTaskInEditorLocation(task.id);
    },
    { task, entries },
  );
  const stream = page.locator("[class*='_stream_']:visible");
  await expect(stream.locator(":scope > *")).toHaveCount(80 * 3);
  await page.evaluate(() => document.fonts.ready);
  return stream;
}

for (const placement of ["editor", "toolWindow"] as const) {
  test(`lets small upward wheel steps leave the end while replies stream in the ${placement}`, async ({ page }) => {
    // Streams into an 80-turn conversation for several seconds: close to 30 s on CI runners.
    test.slow();
    const stream = await openHistory(page);
    await page.evaluate(
      async ({ id, placement }) => {
        const path = "/src/features/agents/store.ts";
        const store = await import(path);
        const state = store.useAgents.getState();
        store.useAgents.setState({
          tasks: new Map(state.tasks).set(id, { ...state.tasks.get(id)!, status: "running" }),
        });
        if (placement === "toolWindow") store.dockTask(id);
      },
      { id: task.id, placement },
    );
    // The working indicator ends the conversation, after its rows.
    await expect(stream.getByRole("status").getByText("Working…", { exact: true })).toBeVisible();
    await expect(stream.locator(":scope > *")).toHaveCount(80 * 3 + 1);
    await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    const timer = await page.evaluate(async (id) => {
      const path = "/src/features/agents/store.ts";
      const store = await import(path);
      const el = [...document.querySelectorAll<HTMLElement>("[class*='_stream_']")].find((el) => el.offsetHeight)!;
      el.addEventListener(
        "wheel",
        () => {
          el.dataset.streamWheelStart = String(el.scrollTop);
        },
        { capture: true, once: true },
      );
      let chunks = 0;
      return window.setInterval(() => {
        const state = store.useAgents.getState();
        const entries = state.entries.get(id)!.slice();
        const last = entries.at(-1)!;
        if (last.type !== "agent") throw new Error("Expected a streaming reply");
        entries[entries.length - 1] = { ...last, text: `${last.text}\n\nStreaming chunk ${++chunks}` };
        store.useAgents.setState({ entries: new Map(state.entries).set(id, entries) });
        el.dataset.streamChunks = String(chunks);
      }, 40);
    }, task.id);
    const chunks = async () => Number(await stream.getAttribute("data-stream-chunks"));
    try {
      await stream.hover();
      for (let i = 0; i < 8; i++) {
        const previous = await chunks();
        await page.mouse.wheel(0, -12);
        await expect.poll(chunks).toBeGreaterThan(previous);
      }
      const top = await stream.evaluate((el) => el.scrollTop);
      expect(Number(await stream.getAttribute("data-stream-wheel-start")) - top).toBeGreaterThan(80);
      const previous = await chunks();
      await expect.poll(chunks).toBeGreaterThan(previous + 3);
      expect(Math.abs((await stream.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(1);
      const jump = page.getByRole("button", { name: "Jump to Latest" });
      await expect(jump).toBeVisible();
      await jump.click();
      await expect
        .poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(2);
      const resumed = await chunks();
      await expect.poll(chunks).toBeGreaterThan(resumed + 3);
      await expect
        .poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(2);
    } finally {
      await page.evaluate((timer) => window.clearInterval(timer), timer);
    }
  });
}

for (const selected of [false, true]) {
  test(`keeps long-chat scroll geometry stable while jumping through history (selected: ${selected})`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const stream = await openHistory(page);
    const result = await stream.evaluate(async (el, selected) => {
      let text = "";
      if (selected) {
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        text = window.getSelection()!.toString();
      }
      await new Promise(requestAnimationFrame);
      const initialHeight = el.scrollHeight;
      const samples: Array<{ height: number; drift: number }> = [];
      // A thumb can jump into previously unvisited rows in either direction.
      for (const fraction of [0, 0.75, 0.25, 1, 0.5, 0.1, 0.9, 0]) {
        el.scrollTop = fraction * (initialHeight - el.clientHeight);
        const target = el.scrollTop;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        samples.push({ height: el.scrollHeight, drift: Math.abs(el.scrollTop - target) });
      }
      return { initialHeight, samples, text, after: window.getSelection()!.toString() };
    }, selected);
    expect(result.initialHeight).toBeGreaterThan(10_000);
    for (const sample of result.samples) {
      expect(Math.abs(sample.height - result.initialHeight)).toBeLessThanOrEqual(1);
      expect(sample.drift).toBeLessThanOrEqual(1);
    }
    if (selected) {
      expect(result.text).toContain("Request 0");
      expect(result.text).toContain("Reply 79");
      expect(result.after).toBe(result.text);
      await stream.focus();
      await page.keyboard.press("ControlOrMeta+c");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(result.text);
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
    }
  });
}

test("opens a folded turn with the keyboard and jumps back to the latest reply", async ({ page }) => {
  const stream = await openHistory(page);
  await stream.evaluate((el) => {
    el.scrollTop = 0;
  });
  const jump = page.getByRole("button", { name: "Jump to Latest" });
  await expect(jump).toBeVisible();
  const fold = stream.locator("[class*='_turnFold_']").first();
  const summary = fold.locator(":scope > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(fold).toHaveAttribute("open", "");
  const run = fold.locator("[class*='_processRun_']").first();
  await expect(run).toBeVisible();
  await run.locator(":scope > summary").click();
  await expect(fold.getByText("read src/module-0.ts", { exact: true })).toBeVisible();
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(fold).not.toHaveAttribute("open", "");
  await jump.focus();
  await page.keyboard.press("Enter");
  await expect(jump).toBeHidden();
  await expect.poll(() => stream.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(40);
});
