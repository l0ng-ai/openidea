import { expect, test } from "./fixtures";

test("plugin multiline prompts keep newlines, confirm with a modifier, and cancel", async ({ workbench: page }) => {
  await page.evaluate(async () => {
    const backendPath = "/src/features/plugins/backend.ts";
    const { createMemoryPluginsBackend, setPluginsBackend } = await import(/* @vite-ignore */ backendPath);
    const state = window as unknown as { promptAnswers: unknown[] };
    state.promptAnswers = [];
    setPluginsBackend({
      ...createMemoryPluginsBackend(),
      answerPrompt: async (id: string, answer: string[] | null) => {
        state.promptAnswers.push({ id, answer });
      },
    });
    const bridgePath = "/src/features/plugins/bridge.ts";
    const { handlePluginEvent } = await import(/* @vite-ignore */ bridgePath);
    handlePluginEvent({
      type: "promptRequested",
      pluginId: "test",
      promptId: "multiline",
      prompt: { kind: "inputMultiline", prompt: "Description", value: "First line\nSecond line" },
    });
  });
  const dialog = page.getByRole("dialog", { name: "Description" });
  const field = dialog.getByRole("textbox", { name: "Description" });
  await expect(field).toHaveValue("First line\nSecond line");
  await field.fill("  First line\n\nSecond line  ");
  await field.press("End");
  await field.press("Enter");
  await field.press("T");
  await expect(dialog).toBeVisible();
  await field.press("Meta+Enter");
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { promptAnswers: unknown[] }).promptAnswers))
    .toEqual([{ id: "multiline", answer: ["  First line\n\nSecond line  \nT"] }]);
  await page.evaluate(async () => {
    const path = "/src/features/plugins/bridge.ts";
    const { handlePluginEvent } = await import(/* @vite-ignore */ path);
    handlePluginEvent({
      type: "promptRequested",
      pluginId: "test",
      promptId: "cancel",
      prompt: { kind: "inputMultiline", prompt: "Description", value: null },
    });
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { promptAnswers: unknown[] }).promptAnswers))
    .toEqual([
      { id: "multiline", answer: ["  First line\n\nSecond line  \nT"] },
      { id: "cancel", answer: null },
    ]);
});
