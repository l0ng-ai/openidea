import { Buffer } from "node:buffer";
import type { AgentEntry, AgentTask } from "../src/bindings";
import { expect, test } from "./fixtures";

const task: AgentTask = {
  id: "tool-images",
  title: "Render preview",
  provider: "claude",
  model: null,
  status: "ready",
  isolation: "local",
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
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220" viewBox="0 0 900 220">
<rect width="900" height="220" fill="#f1f5f9"/>
<g fill="#0f766e"><circle cx="150" cy="92" r="48"/><rect x="103" y="137" width="94" height="42" rx="8"/></g>
<g fill="#2563eb"><ellipse cx="450" cy="92" rx="28" ry="48"/><rect x="420" y="137" width="60" height="42" rx="8"/></g>
<g fill="#b45309"><circle cx="750" cy="92" r="48"/><rect x="703" y="137" width="94" height="42" rx="8"/></g>
<g fill="#0f172a" font-size="20" font-family="sans-serif" text-anchor="middle"><text x="150" y="208">Front</text><text x="450" y="208">Side</text><text x="750" y="208">Back</text></g></svg>`;
const image = { mimeType: "image/svg+xml", data: Buffer.from(svg).toString("base64"), name: null };
const entries: AgentEntry[] = [
  {
    type: "user",
    text: "Render three views of the sample model.",
    attachments: [],
    sentMs: 1000,
    doneMs: 2000,
    steered: false,
  },
  { type: "thought", text: "Rendering the sample views." },
  {
    type: "tool",
    id: "render",
    title: "Render preview",
    kind: "read",
    status: "completed",
    locations: [],
    output: null,
    diffs: [],
    images: [image],
  },
  {
    type: "tool",
    id: "inspect",
    title: "Read preview metadata",
    kind: "read",
    status: "completed",
    locations: [],
    output: "Preview generated successfully.",
    diffs: [],
  },
  { type: "agent", text: "The preview is ready: front, side and back." },
];

for (const foldTurns of [true, false]) {
  test(`tool images remain visible and open a full preview with turn folding=${foldTurns}`, async ({
    workbench: page,
  }) => {
    if (!foldTurns) await page.setViewportSize({ width: 700, height: 750 });
    await page.evaluate(
      async ({ task, entries, foldTurns }) => {
        const storePath = "/src/features/agents/store.ts";
        const projectPath = "/src/platform/project.ts";
        const ipcPath = "/src/platform/ipc.ts";
        const store = await import(storePath);
        const { useProject } = await import(projectPath);
        const { commands } = await import(ipcPath);
        commands.agentEntries = async () => ({ status: "ok", data: entries });
        useProject.setState({ settings: { agents: { foldTurns, toolCalls: "grouped" } } });
        store.useAgents.setState({
          loaded: true,
          error: null,
          tasks: new Map([[task.id, task]]),
          entries: new Map([[task.id, entries]]),
          unread: new Set(),
        });
        store.openTaskInEditorLocation(task.id);
      },
      { task, entries, foldTurns },
    );
    await expect(page.getByText("The preview is ready: front, side and back.", { exact: true })).toBeVisible();
    const preview = page.getByRole("img", { name: "Image", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty("naturalWidth", 900);
    expect(await preview.evaluate((img) => img.closest("details") === null)).toBe(true);
    const box = (await preview.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const fold = page.locator("details").first();
    await expect(fold).not.toHaveAttribute("open");
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "Image", exact: true });
    await expect(dialog.getByRole("img")).toHaveJSProperty("naturalWidth", 900);
    await dialog.getByText("Close", { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await fold.locator("summary").first().click();
    await expect(preview).toHaveCount(1);
    await fold.locator("summary").first().click();
    await expect(preview).toBeVisible();
  });
}
