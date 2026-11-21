import { expect, stubDesktop, test } from "./fixtures";

test.use({ reducedMotion: "reduce" });

const NAME = "settlementTranscript";
const TRANSCRIPT = Array.from(
  { length: 78 },
  (_, index) => `Event ${String(index + 1).padStart(3, "0")}\tSettlement record verified`,
).join("\n");

test("the debugger's full value uses the editor font and fills the resized viewer", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 1320, height: 880 });
  await stubDesktop(page);
  await page.evaluate(
    async ({ name, transcript }) => {
      const project = "/src/platform/project.ts";
      const debug = "/src/features/debugger/state.ts";
      const services = "/src/workbench/contributions.ts";
      const { useProject } = await import(/* @vite-ignore */ project);
      const { settings } = useProject.getState();
      useProject.setState({
        settings: { ...settings, editor: { ...settings?.editor, fontSize: 18, lineHeight: 24, tabSize: 8 } },
      });
      const { adoptSession } = await import(/* @vite-ignore */ debug);
      const { toolWindowService } = await import(/* @vite-ignore */ services);
      const ipc = window.__ipc.handlers;
      ipc.debug_scopes = () => [{ name: "Locals", variablesReference: 100, expensive: false }];
      ipc.debug_variables = () => [
        {
          name,
          value: JSON.stringify(transcript.slice(0, 720)),
          typeName: "str",
          variablesReference: 0,
          evaluateName: name,
        },
      ];
      ipc.debug_evaluate_in = () => ({
        name,
        value: JSON.stringify(transcript),
        typeName: "str",
        variablesReference: 0,
        evaluateName: name,
      });
      adoptSession(91, {
        name: "Settlement review",
        adapter: "debugpy",
        status: "paused",
        selectedFrame: 11,
        frames: [{ id: 11, name: "checkout", path: null, line: 0, column: 0, presentationHint: null }],
      });
      toolWindowService().show("debug", true);
    },
    { name: NAME, transcript: TRANSCRIPT },
  );
  const debug = page.getByRole("region", { name: "Debug", exact: true });
  await debug.getByRole("tab", { name: "Threads & Variables", exact: true }).click();
  await debug.getByRole("treeitem").filter({ hasText: NAME }).getByTitle("Show", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Value of ${NAME}` });
  const value = dialog.locator("pre");
  await expect(value).toHaveText(TRANSCRIPT, { useInnerText: false });
  await expect(value).toHaveCSS("font-size", "18px");
  await expect(value).toHaveCSS("line-height", "24px");
  await expect(value).toHaveCSS("tab-size", "8");
  await expect(value).toBeFocused();
  const before = (await value.boundingBox())!.height;
  const grip = (await dialog.getByRole("separator", { name: "Resize", exact: true }).boundingBox())!;
  const x = grip.x + grip.width - 3;
  const y = grip.y + grip.height - 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 190, y + 180, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await value.boundingBox())!.height).toBeGreaterThan(before + 120);
  const overflow = (el: Element) => el.scrollHeight - el.clientHeight;
  expect(await dialog.locator("[data-dialog-body]").evaluate(overflow)).toBe(0);
  expect(await value.evaluate(overflow)).toBeGreaterThan(0);

  await page.setViewportSize({ width: 490, height: 440 });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(value).toBeInViewport({ ratio: 1 });
  await value.evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect(await value.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await value.textContent()).toBe(TRANSCRIPT);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
