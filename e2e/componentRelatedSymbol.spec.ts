import { expect, stubDesktop, test } from "./fixtures";

test("Related Symbol lists an Angular component's template, styles and spec", async ({ workbench: page }, testInfo) => {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const backend = "/src/editor/core/backend.ts";
    const files: Map<string, string> = (await import(backend)).docBackend().files;
    const dir = "/dev/acme-api/src/app/user";
    files.set(
      `${dir}/user.component.ts`,
      '@Component({\n  selector: "app-user",\n  templateUrl: "./user.component.html",\n  styleUrl: "./user.component.scss",\n})\nexport class UserComponent {}\n',
    );
    files.set(`${dir}/user.component.html`, "<p>{{ name }}</p>\n");
    files.set(`${dir}/user.component.scss`, "p { margin: 0; }\n");
    files.set(`${dir}/user.component.spec.ts`, 'describe("UserComponent", () => {});\n');
    window.__ipc.handlers.fs_read_dir = ({ path }) =>
      [...files.keys()]
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(String(path).length + 1).includes("/"))
        .map((p) => ({
          path: p,
          name: p.slice(String(path).length + 1),
          kind: "file",
          size: 0,
          mtimeMs: 0,
          ignored: false,
          excluded: false,
          hidden: false,
        }));
    const contributions = "/src/workbench/contributions.ts";
    await (await import(contributions)).editorService().openFile(`${dir}/user.component.ts`);
  });
  await expect(page.locator(".cm-content").last()).toContainText("templateUrl");
  const related = async () =>
    page.evaluate(async () => {
      const actions = "/src/platform/actions.ts";
      await (await import(actions)).executeAction("navigate.relatedSymbol");
    });
  await related();
  const chooser = page.getByRole("dialog", { name: "Choose Target" });
  const options = chooser.getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText("Template");
  await expect(options.nth(1)).toContainText("Styles");
  await expect(options.nth(2)).toContainText("Test");
  await page.screenshot({ path: testInfo.outputPath("component-related.png"), animations: "disabled" });
  await options.nth(2).click();
  await expect(page.locator(".cm-content").last()).toContainText("describe");
  await related();
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText("user.component.ts");
  await expect(options.nth(0)).toContainText("Source File");
  await page.screenshot({ path: testInfo.outputPath("spec-related.png"), animations: "disabled" });
});
