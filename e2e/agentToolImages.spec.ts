import { Buffer } from "node:buffer";
import type { Page } from "@playwright/test";
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
  {
    type: "user",
    text: "Looks good.",
    attachments: [],
    sentMs: 3000,
    doneMs: 4000,
    steered: false,
  },
  { type: "agent", text: "Glad it helped." },
];

async function showImages(page: Page) {
  await page.evaluate(
    async ({ task, entries }) => {
      const storePath = "/src/features/agents/store.ts";
      const projectPath = "/src/platform/project.ts";
      const ipcPath = "/src/platform/ipc.ts";
      const store = await import(storePath);
      const { useProject } = await import(projectPath);
      const { commands } = await import(ipcPath);
      commands.agentEntries = async () => ({ status: "ok", data: entries });
      useProject.setState({ settings: { agents: { toolCalls: "grouped" } } });
      store.useAgents.setState({
        loaded: true,
        error: null,
        tasks: new Map([[task.id, task]]),
        entries: new Map([[task.id, entries]]),
        unread: new Set(),
      });
      store.openTaskInEditorLocation(task.id);
    },
    { task, entries },
  );
}

test("tool images remain visible and open a full preview", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 700, height: 750 });
  await showImages(page);
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

test("copies full-size PNG pixels from the thumbnail menu and the image preview", async ({
  workbench: page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await showImages(page);
  const thumbnail = page.getByRole("img", { name: "Image", exact: true });
  await expect(thumbnail).toBeVisible();
  const clipboard = () =>
    page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((item) => item.types.includes("image/png"));
      // The write may still be in flight; let the poll try again.
      if (!item) return null;
      const png = await item.getType("image/png");
      const image = await createImageBitmap(png);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixel = [...context.getImageData(150, 92, 1, 1).data];
      image.close();
      return { width: canvas.width, height: canvas.height, type: png.type, pixel };
    });
  await thumbnail.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy Image", exact: true }).click();
  const expected = { width: 900, height: 220, type: "image/png", pixel: [15, 118, 110, 255] };
  await expect.poll(clipboard).toEqual(expected);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await thumbnail.click();
  const dialog = page.getByRole("dialog", { name: "Image", exact: true });
  await dialog.getByRole("button", { name: "Copy Image", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await clipboard()).toEqual(expected);
  await expect(dialog).toBeVisible();
});
