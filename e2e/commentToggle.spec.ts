import { expect, openFromTree, test } from "./fixtures";

// A JSX comment is `{/* … */}` among JSX children, while its own text parses as
// JavaScript, where the tokens are `/* … */`. Toggling must still take it back out.
const SRC = `export function App() {
  return (
    <div>
      <b>x</b>
    </div>
  );
}
`;

test("⌘/ twice on a JSX line gives the line back", async ({ workbench: page }) => {
  await page.evaluate(async (src) => {
    const backendModule = "/src/editor/core/backend.ts";
    const mod = await import(/* @vite-ignore */ backendModule);
    const backend = mod.docBackend() as { files: Map<string, string> };
    backend.files.set("/dev/acme-api/App.tsx", src);
  }, SRC);

  const editor = await openFromTree(page, "App.tsx");
  const content = editor.locator(".cm-content");
  await editor.locator(".cm-line", { hasText: "<b>x</b>" }).click();

  await page.keyboard.press("Meta+/");
  await expect(content).toContainText("{/* <b>x</b> */}");

  await page.keyboard.press("Meta+/");
  await expect(content).not.toContainText("/*");
  await expect(editor.locator(".cm-line", { hasText: "<b>x</b>" })).toHaveText("<b>x</b>");
});
