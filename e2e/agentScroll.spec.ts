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
  await expect(stream.locator(":scope > *")).toHaveCount(entries.length);
  await page.evaluate(() => document.fonts.ready);
  return stream;
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
