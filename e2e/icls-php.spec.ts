import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

const xml = readFileSync(
  process.env.OPENIDEA_ICLS_FIXTURE ?? "src/platform/__fixtures__/colorSchemes/monokai-php.icls",
  "utf8",
);

test("imported PHP colours stay separate from Java and preserve regular text on a dark background", async ({
  workbench: page,
}, info) => {
  await page.evaluate(async (xml) => {
    const iclsPath = "/src/platform/icls.ts";
    const projectPath = "/src/platform/project.ts";
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { parseIcls } = await import(iclsPath);
    const { useProject } = await import(projectPath);
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    const previous = useProject.getState().settings ?? {};
    useProject.setState({
      settings: {
        ...previous,
        editor: {
          ...previous.editor,
          colorScheme: "custom-php",
          customSchemes: { "custom-php": parseIcls(xml).scheme },
          semanticHighlighting: false,
        },
      },
    });
    const backend = docBackend();
    const open = backend.open.bind(backend);
    backend.open = async (...args: Parameters<typeof open>) => {
      const result = await open(...args);
      return args[0].endsWith(".php") ? { ...result, language: "php", uiMode: "PHP" } : result;
    };
    backend.files.set(
      "/dev/acme-api/palette.php",
      "<?php\n/** Plain PHP documentation */\nclass Palette extends BasePalette {\n    var $name = 'Palette';\n    function example($value) {\n        return $this->name == 10;\n    }\n}\n",
    );
    await editorService().openFile("/dev/acme-api/palette.php");
  }, xml);
  const php = page.locator('.cm-editor[data-language="PHP"]');
  await expect(php).toBeVisible();
  await expect(php).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const token = (text: string) =>
    php
      .locator(".cm-content span")
      .filter({ hasText: text })
      .filter({ hasNot: php.locator("span span") });
  await expect(token("$name").first()).toHaveCSS("color", "rgb(72, 216, 238)");
  await expect(token("'Palette'")).toHaveCSS("color", "rgb(255, 231, 146)");
  await expect(token("'Palette'")).toHaveCSS("font-weight", "400");
  await expect(token("class").first()).toHaveCSS("color", "rgb(249, 38, 114)");
  await expect(token("Plain PHP documentation")).toHaveCSS("font-style", "normal");
  await expect(token("BasePalette")).toHaveCSS("color", "rgb(174, 129, 255)");
  await expect(token(";").first()).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(token("example")).toHaveCSS("color", "rgb(141, 225, 45)");
  await expect(token("$name").first()).toHaveCSS("font-weight", "700");
  await page.evaluate(async () => {
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    docBackend().files.set("/dev/acme-api/Palette.java", 'class Palette { String name = "Palette"; }');
    await editorService().openFile("/dev/acme-api/Palette.java");
  });
  const java = page.locator('.cm-editor[data-language="Java"]');
  await expect(java).toBeVisible();
  await expect(java.locator(".cm-content span").filter({ hasText: '"Palette"' })).toHaveCSS("font-weight", "700");
  await page.getByRole("tab", { name: "palette.php", exact: true }).click();
  await expect(php).toBeVisible();
  await expect(token("'Palette'")).toHaveCSS("font-weight", "400");
  await php.screenshot({ path: info.outputPath("php-import.png"), animations: "disabled" });
});
