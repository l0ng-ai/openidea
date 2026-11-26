import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** Opens an empty file, types `abbrev` + Tab and returns the text with `|` at the caret. */
async function expand(page: Page, path: string, abbrev: string) {
  await page.evaluate(async (p) => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    docBackend().files.set(p, "");
    await editorService().openFile(p);
  }, path);
  const content = page.locator(".cm-editor .cm-content").last();
  await content.click();
  await page.keyboard.type(abbrev);
  await page.keyboard.press("Tab");
  return content.evaluate((element) => {
    const view = (element as HTMLElement & { cmTile: { view: import("@codemirror/view").EditorView } }).cmTile.view;
    const text = view.state.doc.toString();
    const at = view.state.selection.main.head;
    return `${text.slice(0, at)}|${text.slice(at)}`;
  });
}

test("React component templates expand in TSX / JSX, named after the file", async ({ workbench: page }) => {
  expect(await expand(page, "/dev/acme-api/src/user-card.tsx", "rafce")).toBe(
    "type Props = {};\n\nconst UserCard = ({}: Props) => {\n  return (\n    <div>\n      |\n    </div>\n  );\n};\n\nexport default UserCard;",
  );
  expect(await expand(page, "/dev/acme-api/src/Profile.jsx", "rcc")).toContain(
    "export default class Profile extends React.Component {",
  );
  expect(await expand(page, "/dev/acme-api/src/util.ts", "rfc")).not.toContain("function");
});
